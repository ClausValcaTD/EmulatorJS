function getProxiedUrl(targetUrl) {
  return `https://corsproxy.io/?${encodeURIComponent(targetUrl)}`;
}

async function loginRA(username, password) {
    const url = getProxiedUrl(`https://retroachievements.org/dorequest.php?r=login&u=${encodeURIComponent(username)}&p=${encodeURIComponent(password)}`);
    const res = await fetch(url);
    const data = await res.json();
    if (data.Success) {
        localStorage.setItem('ra_user', data.User);
        localStorage.setItem('ra_token', data.Token);
        localStorage.setItem('ra_score', data.Score || 0);
        return data;
    } else {
        throw new Error(data.Error || 'Invalid credentials');
    }
}

async function loginWithApiKey(username, apiKey) {
  // Validate API key by fetching the user's summary
  const targetUrl = `https://retroachievements.org/API/API_GetUserSummary.php?u=${encodeURIComponent(username)}&y=${encodeURIComponent(apiKey)}`;
  const proxiedUrl = `https://corsproxy.io/?${encodeURIComponent(targetUrl)}`;

  const res = await fetch(proxiedUrl);
  const data = await res.json();

  // If valid, User profile data is returned with points
  if (data && (data.Points !== undefined || data.User === username)) {
    localStorage.setItem('ra_user', username);
    localStorage.setItem('ra_token', apiKey);
    localStorage.setItem('ra_score', data.Points || 0);
    localStorage.setItem('ra_hardcore_points', data.Points || 0);
    localStorage.setItem('ra_softcore_points', data.SoftcorePoints || 0);
    localStorage.setItem('ra_rank', data.Rank || '—');
    return data;
  } else {
    throw new Error('Invalid Username or API Key');
  }
}

async function getUserPoints(username, token) {
    const targetUrl = `https://retroachievements.org/API/API_GetUserPoints.php?u=${encodeURIComponent(username)}&y=${encodeURIComponent(token)}`;
    const url = getProxiedUrl(targetUrl);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
}

async function getUserRecentlyPlayedGames(username, token, count = 10) {
    const targetUrl = `https://retroachievements.org/API/API_GetUserRecentlyPlayedGames.php?u=${encodeURIComponent(username)}&y=${encodeURIComponent(token)}&c=${count}`;
    const url = getProxiedUrl(targetUrl);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
}

import { md5 } from "./utils.js";
import { rc_parse_trigger, rc_evaluate_trigger, rc_evaluate_richpresence } from "./rcheevos/rcheevos.js";

class RetroAchievements {
    static async loginRA(username, password) {
        return await loginRA(username, password);
    }

    static async loginWithApiKey(username, apiKey) {
        return await loginWithApiKey(username, apiKey);
    }

    constructor(ejs) {
        this.ejs = ejs;
        this.baseUrl = "https://retroachievements.org/dorequest.php";
        this.gameId = null;
        this.achievements = [];
        this.gameData = null;
        this.romMd5 = null;
        this.unlockedIds = new Set();
        this._pollInterval = null;
        this._pingInterval = null;
        this.richPresenceScript = "";
        this.richPresenceText = "";
        this.frameCount = 0;
        this.loadConfig();
    }

    loadConfig() {
        try {
            const raUser = localStorage.getItem("ra_user");
            const raToken = localStorage.getItem("ra_token");
            const raw = localStorage.getItem("ejs-retroachievements-config");
            if (raUser && raToken) {
                this.username = raUser;
                this.token = raToken;
                this.hardcore = raw ? (JSON.parse(raw).hardcore === true) : false;
            } else if (raw) {
                const config = JSON.parse(raw);
                this.username = config.username || "";
                this.token = config.token || "";
                this.hardcore = config.hardcore === true;
            } else {
                this.username = "";
                this.token = "";
                this.hardcore = false;
            }
        } catch (e) {
            this.username = "";
            this.token = "";
            this.hardcore = false;
        }
    }

    saveConfig(username, token, hardcore) {
        this.username = username !== undefined ? username : this.username;
        this.token = token !== undefined ? token : this.token;
        this.hardcore = hardcore !== undefined ? !!hardcore : this.hardcore;

        const config = {
            username: this.username,
            token: this.token,
            hardcore: this.hardcore
        };

        localStorage.setItem("ejs-retroachievements-config", JSON.stringify(config));
    }

    peek(address, numBytes) {
        if (typeof window === "undefined" || !window.Module || typeof window.Module._retro_get_memory_data !== "function") {
            return 0;
        }
        const ramPtr = window.Module._retro_get_memory_data(0); // RETRO_MEMORY_SYSTEM_RAM = 0
        const ramSize = window.Module._retro_get_memory_size(0);
        if (!ramPtr || !ramSize || address < 0 || address >= ramSize) {
            return 0;
        }
        const heap = window.Module.HEAPU8;
        if (!heap) return 0;

        let val = 0;
        for (let i = 0; i < numBytes; i++) {
            if (address + i < ramSize) {
                val |= (heap[ramPtr + address + i] << (i * 8));
            }
        }
        return val >>> 0;
    }

    async initGame(romBytes) {
        if (!romBytes) return;
        this.romMd5 = md5(romBytes);
        if (this.ejs.debug) console.log("[RetroAchievements] Computed ROM MD5:", this.romMd5);

        try {
            const gameId = await this.fetchGameId(this.romMd5);
            if (gameId && gameId > 0) {
                this.gameId = gameId;
                if (this.ejs.debug) console.log("[RetroAchievements] Identified Game ID:", this.gameId);
                await this.fetchPatchData(this.gameId);
                await this.startSession();
                this.startAchievementPolling();
            } else {
                if (this.ejs.debug) console.log("[RetroAchievements] No Game ID matched for MD5:", this.romMd5);
            }
        } catch (e) {
            if (this.ejs.debug) console.warn("[RetroAchievements] Initialization failed:", e);
        }
    }

    async startSession() {
        this.unlockedIds = new Set();
        if (!this.gameId || !this.romMd5) return;

        if (!this.username || !this.token) {
            if (this.ejs.debug) console.log("[RetroAchievements] Guest mode active (no credentials)");
            return;
        }

        try {
            const url = `${this.baseUrl}?r=startsession`
                + `&g=${this.gameId}`
                + `&z=${encodeURIComponent(this.username)}`
                + `&y=${encodeURIComponent(this.token)}`
                + `&h=${this.hardcore ? 1 : 0}`
                + `&m=${this.romMd5}`;
            const res = await fetch(getProxiedUrl(url));
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            const unlocks = (this.hardcore ? data.HardcoreUnlocks : data.Unlocks) || data.Unlocks || data.HardcoreUnlocks || [];
            if (Array.isArray(unlocks)) {
                unlocks.forEach(item => {
                    if (typeof item === "object" && item !== null) {
                        const id = item.ID || item.id || item.AchievementID;
                        if (id !== undefined) this.unlockedIds.add(Number(id));
                    } else if (item !== undefined) {
                        this.unlockedIds.add(Number(item));
                    }
                });
            }
            if (this.ejs.debug) console.log("[RetroAchievements] Session started. Unlocked count:", this.unlockedIds.size);

            this.startPingInterval();
        } catch (e) {
            if (this.ejs.debug) console.warn("[RetroAchievements] Failed to start session:", e);
        }
    }

    startPingInterval() {
        this.stopPingInterval();
        this.sendPing();
        this._pingInterval = setInterval(() => {
            this.sendPing();
        }, 120000); // Send keep-alive ping every 2 minutes
    }

    stopPingInterval() {
        if (this._pingInterval) {
            clearInterval(this._pingInterval);
            this._pingInterval = null;
        }
    }

    async sendPing() {
        if (!this.username || !this.token || !this.gameId) return;
        try {
            const richText = this.richPresenceText || ("Playing " + (this.gameData?.Title || "Game"));
            const url = `${this.baseUrl}?r=ping`
                + `&u=${encodeURIComponent(this.username)}`
                + `&t=${encodeURIComponent(this.token)}`
                + `&g=${this.gameId}`
                + `&m=${encodeURIComponent(richText)}`;
            await fetch(getProxiedUrl(url));
            if (this.ejs.debug) console.log("[RetroAchievements] Pinged Rich Presence:", richText);
        } catch (e) {
            if (this.ejs.debug) console.warn("[RetroAchievements] Ping failed:", e);
        }
    }

    startAchievementPolling() {
        if (this._pollInterval) return;
        this.frameCount = 0;
        this._pollInterval = setInterval(() => {
            this.checkAchievements();
        }, 16); // Poll every ~16ms (~60 FPS)
    }

    stopAchievementPolling() {
        if (this._pollInterval) {
            clearInterval(this._pollInterval);
            this._pollInterval = null;
        }
        this.stopPingInterval();
    }

    checkAchievements() {
        this.frameCount++;

        const peekFn = (addr, numBytes) => this.peek(addr, numBytes);

        // Every 60 frames (~1s), evaluate triggers & Rich Presence
        if (this.frameCount % 60 === 0) {
            if (this.richPresenceScript) {
                this.richPresenceText = rc_evaluate_richpresence(this.richPresenceScript, peekFn);
            }

            if (this.achievements && this.achievements.length > 0) {
                for (const achievement of this.achievements) {
                    const achId = achievement.ID || achievement.id;
                    if (achId === undefined || this.unlockedIds.has(Number(achId))) continue;

                    if (!achievement._parsedTrigger && achievement.MemAddr) {
                        achievement._parsedTrigger = rc_parse_trigger(achievement.MemAddr);
                    }

                    if (achievement._parsedTrigger) {
                        const conditionMet = rc_evaluate_trigger(achievement._parsedTrigger, peekFn);
                        if (conditionMet) {
                            this.awardAchievement(achievement);
                        }
                    }
                }
            }
        }
    }

    async awardAchievement(achievement) {
        const achId = achievement.ID || achievement.id;
        if (achId === undefined) return;
        const numericId = Number(achId);
        if (this.unlockedIds.has(numericId)) return;

        this.unlockedIds.add(numericId);
        this.showUnlockToast(achievement);

        if (!this.username || !this.token) return; // guest — local only

        try {
            const url = `${this.baseUrl}?r=awardachievement`
                + `&z=${encodeURIComponent(this.username)}`
                + `&y=${encodeURIComponent(this.token)}`
                + `&a=${numericId}`
                + `&h=${this.hardcore ? 1 : 0}`
                + `&m=${this.romMd5}`;
            const res = await fetch(getProxiedUrl(url));
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            if (this.ejs.debug) console.log("[RetroAchievements] Awarded:", achievement.Title || achievement.title, data);
        } catch (e) {
            console.warn("[RetroAchievements] Failed to submit award:", e);
            // Do NOT remove from unlockedIds — don't double-toast on retry
        }
    }

    async fetchGameId(hash) {
        let url = `${this.baseUrl}?r=gameid&m=${hash}`;
        if (this.username && this.token) {
            url += `&z=${encodeURIComponent(this.username)}&y=${encodeURIComponent(this.token)}`;
        }
        const response = await fetch(getProxiedUrl(url));
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        return data.GameID || data.gameID || data.ID || 0;
    }

    async fetchPatchData(gameId) {
        let url = `${this.baseUrl}?r=patch&g=${gameId}`;
        if (this.username && this.token) {
            url += `&z=${encodeURIComponent(this.username)}&y=${encodeURIComponent(this.token)}`;
        }
        const response = await fetch(getProxiedUrl(url));
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        this.gameData = data;

        const patchData = data.PatchData || data;
        if (patchData.Achievements && Array.isArray(patchData.Achievements)) {
            this.achievements = patchData.Achievements;
        } else if (data.Achievements && Array.isArray(data.Achievements)) {
            this.achievements = data.Achievements;
        } else {
            this.achievements = [];
        }

        this.richPresenceScript = patchData.RichPresencePatch || patchData.RichPresence || data.RichPresencePatch || data.RichPresence || data.rich_presence || "";

        for (const ach of this.achievements) {
            if (ach.MemAddr) {
                ach._parsedTrigger = rc_parse_trigger(ach.MemAddr);
            }
        }

        if (this.ejs.debug) console.log(`[RetroAchievements] Loaded ${this.achievements.length} achievements & Rich Presence script.`);

        return data;
    }

    playChime() {
        try {
            const AudioContext = window.AudioContext || window.webkitAudioContext;
            if (!AudioContext) return;
            const ctx = new AudioContext();

            const playNote = (freq, startTime, duration) => {
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();

                osc.type = "sine";
                osc.frequency.setValueAtTime(freq, ctx.currentTime + startTime);

                gain.gain.setValueAtTime(0.001, ctx.currentTime + startTime);
                gain.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + startTime + 0.03);
                gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + startTime + duration);

                osc.connect(gain);
                gain.connect(ctx.destination);

                osc.start(ctx.currentTime + startTime);
                osc.stop(ctx.currentTime + startTime + duration);
            };

            // Classic retro ascending chime sequence (C5 -> E5 -> G5 -> C6)
            playNote(523.25, 0.00, 0.15); // C5
            playNote(659.25, 0.12, 0.15); // E5
            playNote(783.99, 0.24, 0.15); // G5
            playNote(1046.50, 0.36, 0.40); // C6
        } catch (e) {
            console.warn("[RetroAchievements] Could not play chime:", e);
        }
    }

    showUnlockToast(achievement) {
        const title = achievement.Title || achievement.title || "Achievement Unlocked!";
        const description = achievement.Description || achievement.description || "";
        const points = achievement.Points || achievement.points || 0;
        const badge = achievement.BadgeName || achievement.badge || "00000";

        const badgeUrl = badge.startsWith("http")
            ? badge
            : `https://media.retroachievements.org/Badge/${badge}.png`;

        const toast = document.createElement("div");
        toast.className = "ra_toast_notification";

        toast.innerHTML = `
            <div class="ra_toast_badge_container">
                <img src="${badgeUrl}" alt="Badge" class="ra_toast_badge" onerror="this.src='data:image/svg+xml;utf8,<svg xmlns=\\'http://www.w3.org/2000/svg\\' viewBox=\\'0 0 24 24\\' fill=\\'%23f59e0b\\'><path d=\\'M12 2l2.4 7.4h7.6l-6.2 4.5 2.4 7.4-6.2-4.5-6.2 4.5 2.4-7.4-6.2-4.5h7.6z\\'/></svg>';">
            </div>
            <div class="ra_toast_content">
                <div class="ra_toast_header">
                    <span class="ra_toast_tag">ACHIEVEMENT UNLOCKED</span>
                    <span class="ra_toast_points">+${points} PTS</span>
                </div>
                <div class="ra_toast_title">${title}</div>
                <div class="ra_toast_desc">${description}</div>
            </div>
        `;

        const container = (this.ejs && this.ejs.frontend && this.ejs.frontend.elements && this.ejs.frontend.elements.parent)
            ? this.ejs.frontend.elements.parent
            : document.body;

        container.appendChild(toast);

        this.playChime();

        requestAnimationFrame(() => {
            toast.classList.add("ra_toast_visible");
        });

        setTimeout(() => {
            toast.classList.remove("ra_toast_visible");
            toast.classList.add("ra_toast_hiding");
            setTimeout(() => {
                if (toast.remove) toast.remove();
                else if (toast.parentNode) toast.parentNode.removeChild(toast);
            }, 500);
        }, 4000);
    }

    showProgressToast(achievement, current, target) {
        const title = achievement.Title || achievement.title || "Achievement Progress";
        let toast = document.querySelector(".ra_progress_toast");
        if (!toast) {
            toast = document.createElement("div");
            toast.className = "ra_progress_toast";
            const container = (this.ejs && this.ejs.frontend && this.ejs.frontend.elements && this.ejs.frontend.elements.parent)
                ? this.ejs.frontend.elements.parent
                : document.body;
            container.appendChild(toast);
        }

        toast.innerText = `${title}: ${current} / ${target}`;

        requestAnimationFrame(() => {
            toast.classList.add("visible");
        });

        if (this._progressTimeout) clearTimeout(this._progressTimeout);
        this._progressTimeout = setTimeout(() => {
            toast.classList.remove("visible");
            setTimeout(() => {
                if (toast && toast.remove) toast.remove();
                else if (toast && toast.parentNode) toast.parentNode.removeChild(toast);
            }, 300);
        }, 2000);
    }

    unlockAchievement(achievement) {
        if (achievement) {
            const achId = achievement.ID || achievement.id;
            if (achId !== undefined) {
                this.unlockedIds.delete(Number(achId));
            }
            this.awardAchievement(achievement);
        }
    }
}

export { RetroAchievements, loginRA, loginWithApiKey, getUserPoints, getUserRecentlyPlayedGames, getProxiedUrl };
