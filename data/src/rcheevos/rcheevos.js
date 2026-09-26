/**
 * rcheevos.js - Lightweight JavaScript evaluator for RetroAchievements logic
 * Implements trigger condition evaluation and Rich Presence script parsing/evaluation.
 */

function parseOperand(str) {
    str = (str || "").trim();
    if (!str) return { type: "value", value: 0, getValue: () => 0 };

    if (str.startsWith("v") || str.startsWith("V")) {
        const raw = str.substring(1);
        const val = raw.startsWith("0x") || raw.startsWith("0X") ? parseInt(raw, 16) : parseInt(raw, 10);
        const num = isNaN(val) ? 0 : val;
        return { type: "value", value: num, getValue: () => num };
    }

    if (/^0x/i.test(str)) {
        const prefix = str.substring(0, 3).toUpperCase();
        if (prefix === "0XH") {
            const addr = parseInt(str.substring(3), 16) || 0;
            return { type: "mem", size: 1, addr, getValue: (peek) => peek(addr, 1) };
        } else if (prefix === "0XX") {
            const addr = parseInt(str.substring(3), 16) || 0;
            return { type: "mem", size: 4, addr, getValue: (peek) => peek(addr, 4) };
        } else if (prefix === "0XW") {
            const addr = parseInt(str.substring(3), 16) || 0;
            return { type: "mem", size: 3, addr, getValue: (peek) => peek(addr, 3) };
        } else if (prefix === "0XI") {
            const addr = parseInt(str.substring(3), 16) || 0;
            return { type: "mem", size: 2, addr, isSigned: true, getValue: (peek) => {
                const u = peek(addr, 2);
                return (u << 16) >> 16;
            }};
        } else if (prefix === "0XJ") {
            const addr = parseInt(str.substring(3), 16) || 0;
            return { type: "mem", size: 4, addr, isSigned: true, getValue: (peek) => peek(addr, 4) | 0 };
        } else if (prefix >= "0XM" && prefix <= "0XT") {
            const bitIndex = prefix.charCodeAt(2) - "M".charCodeAt(0);
            const addr = parseInt(str.substring(3), 16) || 0;
            return { type: "bit", addr, bitIndex, getValue: (peek) => (peek(addr, 1) >> bitIndex) & 1 };
        } else if (prefix === "0XL") {
            const addr = parseInt(str.substring(3), 16) || 0;
            return { type: "mem", size: 1, addr, getValue: (peek) => peek(addr, 1) & 0x0F };
        } else if (prefix === "0XC") {
            const addr = parseInt(str.substring(3), 16) || 0;
            return { type: "mem", size: 1, addr, getValue: (peek) => (peek(addr, 1) >> 4) & 0x0F };
        } else {
            const addr = parseInt(str.substring(2), 16) || 0;
            return { type: "mem", size: 2, addr, getValue: (peek) => peek(addr, 2) };
        }
    }

    const val = str.startsWith("0x") || str.startsWith("0X") ? parseInt(str, 16) : parseInt(str, 10);
    const num = isNaN(val) ? 0 : val;
    return { type: "value", value: num, getValue: () => num };
}

function parseCondition(condStr) {
    condStr = (condStr || "").trim();
    let flag = "";
    if (condStr.length > 2 && condStr[1] === ":") {
        flag = condStr[0].toUpperCase();
        condStr = condStr.substring(2);
    }

    let hits = 0;
    const hitMatch = condStr.match(/\((\d+)\)$/);
    if (hitMatch) {
        hits = parseInt(hitMatch[1], 10) || 0;
        condStr = condStr.substring(0, condStr.lastIndexOf("(")).trim();
    }

    const opRegex = /(<=|>=|!=|==|=|<|>)/;
    const match = condStr.match(opRegex);

    let op1Str = condStr;
    let op2Str = "v0";
    let operator = "";

    if (match) {
        operator = match[0];
        const idx = condStr.indexOf(operator);
        op1Str = condStr.substring(0, idx);
        op2Str = condStr.substring(idx + operator.length);
    }

    const op1 = parseOperand(op1Str);
    const op2 = parseOperand(op2Str);

    return {
        flag,
        op1,
        operator,
        op2,
        requiredHits: hits,
        currentHits: 0,
        evaluate(peek, modifierVal = 0) {
            const val1 = op1.getValue(peek) + modifierVal;
            const val2 = op2.getValue(peek);

            if (!operator) return true;

            let result = false;
            switch (operator) {
                case "=":
                case "==":
                    result = (val1 === val2);
                    break;
                case "!=":
                    result = (val1 !== val2);
                    break;
                case "<":
                    result = (val1 < val2);
                    break;
                case "<=":
                    result = (val1 <= val2);
                    break;
                case ">":
                    result = (val1 > val2);
                    break;
                case ">=":
                    result = (val1 >= val2);
                    break;
                default:
                    result = true;
                    break;
            }

            if (result) {
                this.currentHits++;
            }

            if (this.requiredHits > 0) {
                return this.currentHits >= this.requiredHits;
            }

            return result;
        }
    };
}

class TriggerGroup {
    constructor(groupStr) {
        this.groupStr = groupStr;
        this.conditions = (groupStr || "")
            .split("_")
            .filter(Boolean)
            .map(s => parseCondition(s));
    }

    evaluate(peek) {
        let modifier = 0;
        let paused = false;
        let reset = false;
        let groupResult = true;

        for (const cond of this.conditions) {
            if (cond.flag === "R") {
                if (cond.evaluate(peek, modifier)) {
                    reset = true;
                }
                modifier = 0;
                continue;
            }

            if (cond.flag === "P") {
                if (cond.evaluate(peek, modifier)) {
                    paused = true;
                }
                modifier = 0;
                continue;
            }

            if (cond.flag === "A") {
                modifier += cond.op1.getValue(peek);
                continue;
            }

            if (cond.flag === "B") {
                modifier -= cond.op1.getValue(peek);
                continue;
            }

            const met = cond.evaluate(peek, modifier);
            modifier = 0;

            if (!met) {
                groupResult = false;
            }
        }

        if (reset) {
            for (const c of this.conditions) {
                c.currentHits = 0;
            }
            return false;
        }

        if (paused) {
            return false;
        }

        return groupResult;
    }
}

class Trigger {
    constructor(triggerStr) {
        this.raw = triggerStr || "";
        const parts = this.raw.split(/S|Alt/i);
        this.coreGroup = new TriggerGroup(parts[0] || "");
        this.altGroups = parts.slice(1).map(s => new TriggerGroup(s));
    }

    evaluate(peek) {
        if (typeof peek !== "function") return false;

        const coreMet = this.coreGroup.evaluate(peek);
        if (!coreMet) return false;

        if (this.altGroups.length === 0) {
            return true;
        }

        for (const alt of this.altGroups) {
            if (alt.evaluate(peek)) {
                return true;
            }
        }

        return false;
    }
}

function rc_parse_trigger(triggerStr) {
    return new Trigger(triggerStr);
}

function rc_evaluate_trigger(trigger, peek) {
    if (!trigger) return false;
    if (typeof trigger === "string") {
        trigger = rc_parse_trigger(trigger);
    }
    return trigger.evaluate(peek);
}

function formatTime(totalSeconds) {
    totalSeconds = Math.max(0, Math.floor(totalSeconds || 0));
    const hours = Math.floor(totalSeconds / 3600);
    const mins = Math.floor((totalSeconds % 3600) / 60);
    const secs = totalSeconds % 60;

    const pad = (n) => (n < 10 ? "0" + n : "" + n);
    if (hours > 0) {
        return `${hours}:${pad(mins)}:${pad(secs)}`;
    }
    return `${pad(mins)}:${pad(secs)}`;
}

function formatValue(value, formatType) {
    const type = (formatType || "VALUE").toUpperCase();
    if (type === "SECS" || type === "TIME") {
        return formatTime(value);
    }
    if (type === "FRAMES") {
        return formatTime(value / 60);
    }
    return String(value !== undefined ? value : 0);
}

function rc_evaluate_richpresence(script, peek) {
    if (!script || typeof script !== "string" || typeof peek !== "function") {
        return "";
    }

    const lookups = {};
    const formats = {};
    const displayLines = [];

    const lines = script.split(/\r?\n/);
    let currentLookup = null;
    let currentFormat = null;
    let inDisplay = false;

    for (let line of lines) {
        line = line.trim();
        if (!line || line.startsWith("//") || line.startsWith("#")) continue;

        if (line.toLowerCase() === "display:") {
            inDisplay = true;
            currentLookup = null;
            currentFormat = null;
            continue;
        }

        const lookupMatch = line.match(/^Lookup:(.+)$/i);
        if (lookupMatch) {
            inDisplay = false;
            currentLookup = lookupMatch[1].trim();
            lookups[currentLookup] = { mapping: {}, default: null };
            currentFormat = null;
            continue;
        }

        const formatMatch = line.match(/^Format:(.+)$/i);
        if (formatMatch) {
            inDisplay = false;
            currentFormat = formatMatch[1].trim();
            formats[currentFormat] = "VALUE";
            currentLookup = null;
            continue;
        }

        if (currentLookup) {
            if (line.startsWith("*=")) {
                lookups[currentLookup].default = line.substring(2).trim();
            } else {
                const eqIdx = line.indexOf("=");
                if (eqIdx > -1) {
                    const key = line.substring(0, eqIdx).trim();
                    const val = line.substring(eqIdx + 1).trim();
                    lookups[currentLookup].mapping[key] = val;
                }
            }
            continue;
        }

        if (currentFormat) {
            const fmtIdx = line.indexOf("=");
            if (fmtIdx > -1) {
                const key = line.substring(0, fmtIdx).trim().toUpperCase();
                const val = line.substring(fmtIdx + 1).trim();
                if (key === "FORMATTYPE") {
                    formats[currentFormat] = val.toUpperCase();
                }
            }
            continue;
        }

        if (inDisplay) {
            displayLines.push(line);
        }
    }

    let selectedDisplay = "";
    for (const line of displayLines) {
        if (line.startsWith("?")) {
            const parts = line.substring(1).split("?");
            if (parts.length >= 2) {
                const condStr = parts[0];
                const textStr = parts.slice(1).join("?");
                const trigger = rc_parse_trigger(condStr);
                if (trigger.evaluate(peek)) {
                    selectedDisplay = textStr;
                    break;
                }
            }
        } else {
            selectedDisplay = line;
            break;
        }
    }

    if (!selectedDisplay) return "";

    const macroRegex = /@([A-Za-z0-9_]+)\(([^)]+)\)/g;
    const evaluatedText = selectedDisplay.replace(macroRegex, (match, macroName, operandStr) => {
        const op = parseOperand(operandStr);
        const rawVal = op.getValue(peek);

        if (lookups[macroName]) {
            const lk = lookups[macroName];
            const keyStr = String(rawVal);
            if (lk.mapping[keyStr] !== undefined) {
                return lk.mapping[keyStr];
            }
            if (lk.default !== null) {
                return lk.default;
            }
            return String(rawVal);
        }

        if (formats[macroName]) {
            return formatValue(rawVal, formats[macroName]);
        }

        return String(rawVal);
    });

    return evaluatedText;
}

export {
    rc_parse_trigger,
    rc_evaluate_trigger,
    rc_evaluate_richpresence,
    Trigger
};
