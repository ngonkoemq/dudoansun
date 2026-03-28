// server.js – Kết hợp WebSocket, API và thuật toán dự đoán Sun.Win
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const os = require('os');
const fs = require('fs');
const path = require('path');

// ==================== CẤU HÌNH ====================
const PORT = process.env.PORT || 3001;
const WS_URL = 'wss://websocket.azhkthg1.net/websocket?token=eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJhbW91bnQiOjAsInVzZXJuYW1lIjoiU0NfYXBpc3Vud2luMTIzIn0.hgrRbSV6vnBwJMg9ZFtbx3rRu9mX_hZMZ_m5gMNhkw0';
const WS_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    "Origin": "https://play.sun.win"
};
const RECONNECT_DELAY = 2500;
const PING_INTERVAL = 15000;
const MAX_HISTORY = 100;
const MAX_PREDICTION_HISTORY = 200;

// ==================== BIẾN TOÀN CỤC ====================
let ws = null;
let pingInterval = null;
let reconnectTimeout = null;
let currentSessionId = null;
let patternHistory = [];
let apiResponseData = {
    "Phien": null,
    "Xuc_xac_1": null,
    "Xuc_xac_2": null,
    "Xuc_xac_3": null,
    "Tong": null,
    "Ket_qua": "",
    "id": "@tiendataox",
    "server_time": new Date().toISOString(),
    "update_count": 0
};

// Lịch sử dùng riêng cho thuật toán dự đoán (có cấu trúc phù hợp)
let historyForPrediction = [];   // Mỗi phần tử: { session, result, totalScore, d1, d2, d3, timestamp }

// ==================== CÁC HÀM TIỆN ÍCH CHUNG ====================
function getNetworkInfo() {
    const interfaces = os.networkInterfaces();
    let localIP = '127.0.0.1';
    for (const ifaceName in interfaces) {
        for (const iface of interfaces[ifaceName]) {
            if (!iface.internal && iface.family === 'IPv4') {
                localIP = iface.address;
                break;
            }
        }
    }
    return { localIP, publicIP: null };
}

// ==================== CÁC HÀM DỰ ĐOÁN TỪ CODE 3 ====================
function detectStreakAndBreak(history) {
    if (!history || history.length === 0) return { streak: 0, currentResult: null, breakProb: 0.0 };
    let streak = 1;
    const currentResult = history[history.length - 1].result;
    for (let i = history.length - 2; i >= 0; i--) {
        if (history[i].result === currentResult) streak++;
        else break;
    }
    const last15 = history.slice(-15).map(h => h.result);
    if (!last15.length) return { streak, currentResult, breakProb: 0.0 };
    const switches = last15.slice(1).reduce((count, curr, idx) => count + (curr !== last15[idx] ? 1 : 0), 0);
    const taiCount = last15.filter(r => r === 'Tài').length;
    const xiuCount = last15.filter(r => r === 'Xỉu').length;
    const imbalance = Math.abs(taiCount - xiuCount) / last15.length;
    let breakProb = 0.0;
    if (streak >= 8) {
        breakProb = Math.min(0.6 + (switches / 15) + imbalance * 0.15, 0.9);
    } else if (streak >= 5) {
        breakProb = Math.min(0.35 + (switches / 10) + imbalance * 0.25, 0.85);
    } else if (streak >= 3 && switches >= 7) {
        breakProb = 0.3;
    }
    return { streak, currentResult, breakProb };
}

function evaluateModelPerformance(history, modelName, lookback = 10) {
    // Giả lập: dùng modelPredictions lưu dự đoán trước đó
    if (!modelPredictions[modelName] || history.length < 2) return 1.0;
    lookback = Math.min(lookback, history.length - 1);
    let correctCount = 0;
    for (let i = 0; i < lookback; i++) {
        const pred = modelPredictions[modelName][history[history.length - (i + 2)].session] || 0;
        const actual = history[history.length - (i + 1)].result;
        if ((pred === 1 && actual === 'Tài') || (pred === 2 && actual === 'Xỉu')) {
            correctCount++;
        }
    }
    const performanceScore = lookback > 0 ? 1.0 + (correctCount - lookback / 2) / (lookback / 2) : 1.0;
    return Math.max(0.5, Math.min(1.5, performanceScore));
}

function smartBridgeBreak(history) {
    if (!history || history.length < 3) return { prediction: 0, breakProb: 0.0, reason: 'Không đủ dữ liệu để bẻ cầu' };
    const { streak, currentResult, breakProb } = detectStreakAndBreak(history);
    const last20 = history.slice(-20).map(h => h.result);
    const lastScores = history.slice(-20).map(h => h.totalScore || 0);
    let breakProbability = breakProb;
    let reason = '';
    const avgScore = lastScores.reduce((sum, score) => sum + score, 0) / (lastScores.length || 1);
    const scoreDeviation = lastScores.reduce((sum, score) => sum + Math.abs(score - avgScore), 0) / (lastScores.length || 1);
    const last5 = last20.slice(-5);
    const patternCounts = {};
    for (let i = 0; i <= last20.length - 3; i++) {
        const pattern = last20.slice(i, i + 3).join(',');
        patternCounts[pattern] = (patternCounts[pattern] || 0) + 1;
    }
    const mostCommonPattern = Object.entries(patternCounts).sort((a, b) => b[1] - a[1])[0];
    const isStablePattern = mostCommonPattern && mostCommonPattern[1] >= 3;
    if (streak >= 6) {
        breakProbability = Math.min(breakProbability + 0.15, 0.9);
        reason = `[Bẻ Cầu] Chuỗi ${streak} ${currentResult} dài, khả năng bẻ cầu cao`;
    } else if (streak >= 4 && scoreDeviation > 3) {
        breakProbability = Math.min(breakProbability + 0.1, 0.85);
        reason = `[Bẻ Cầu] Biến động điểm số lớn (${scoreDeviation.toFixed(1)}), khả năng bẻ cầu tăng`;
    } else if (isStablePattern && last5.every(r => r === currentResult)) {
        breakProbability = Math.min(breakProbability + 0.05, 0.8);
        reason = `[Bẻ Cầu] Phát hiện mẫu lặp ${mostCommonPattern[0]}, có khả năng bẻ cầu`;
    } else {
        breakProbability = Math.max(breakProbability - 0.15, 0.15);
        reason = `[Bẻ Cầu] Không phát hiện mẫu bẻ cầu mạnh, tiếp tục theo cầu`;
    }
    let prediction = breakProbability > 0.65 ? (currentResult === 'Tài' ? 2 : 1) : (currentResult === 'Tài' ? 1 : 2);
    return { prediction, breakProb: breakProbability, reason };
}

function trendAndProb(history) {
    if (!history || history.length < 3) return 0;
    const { streak, currentResult, breakProb } = detectStreakAndBreak(history);
    if (streak >= 5) {
        if (breakProb > 0.75) return currentResult === 'Tài' ? 2 : 1;
        return currentResult === 'Tài' ? 1 : 2;
    }
    const last15 = history.slice(-15).map(h => h.result);
    if (!last15.length) return 0;
    const weights = last15.map((_, i) => Math.pow(1.2, i));
    const taiWeighted = weights.reduce((sum, w, i) => sum + (last15[i] === 'Tài' ? w : 0), 0);
    const xiuWeighted = weights.reduce((sum, w, i) => sum + (last15[i] === 'Xỉu' ? w : 0), 0);
    const totalWeight = taiWeighted + xiuWeighted;
    const last10 = last15.slice(-10);
    const patterns = [];
    if (last10.length >= 4) {
        for (let i = 0; i <= last10.length - 4; i++) {
            patterns.push(last10.slice(i, i + 4).join(','));
        }
    }
    const patternCounts = patterns.reduce((acc, p) => { acc[p] = (acc[p] || 0) + 1; return acc; }, {});
    const mostCommon = Object.entries(patternCounts).sort((a, b) => b[1] - a[1])[0];
    if (mostCommon && mostCommon[1] >= 3) {
        const pattern = mostCommon[0].split(',');
        return pattern[pattern.length - 1] !== last10[last10.length - 1] ? 1 : 2;
    } else if (totalWeight > 0 && Math.abs(taiWeighted - xiuWeighted) / totalWeight >= 0.25) {
        return taiWeighted > xiuWeighted ? 2 : 1;
    }
    return last15[last15.length - 1] === 'Xỉu' ? 1 : 2;
}

function shortPattern(history) {
    if (!history || history.length < 3) return 0;
    const { streak, currentResult, breakProb } = detectStreakAndBreak(history);
    if (streak >= 4) {
        if (breakProb > 0.75) return currentResult === 'Tài' ? 2 : 1;
        return currentResult === 'Tài' ? 1 : 2;
    }
    const last8 = history.slice(-8).map(h => h.result);
    if (!last8.length) return 0;
    const patterns = [];
    if (last8.length >= 3) {
        for (let i = 0; i <= last8.length - 3; i++) {
            patterns.push(last8.slice(i, i + 3).join(','));
        }
    }
    const patternCounts = patterns.reduce((acc, p) => { acc[p] = (acc[p] || 0) + 1; return acc; }, {});
    const mostCommon = Object.entries(patternCounts).sort((a, b) => b[1] - a[1])[0];
    if (mostCommon && mostCommon[1] >= 2) {
        const pattern = mostCommon[0].split(',');
        return pattern[pattern.length - 1] !== last8[last8.length - 1] ? 1 : 2;
    }
    return last8[last8.length - 1] === 'Xỉu' ? 1 : 2;
}

function meanDeviation(history) {
    if (!history || history.length < 3) return 0;
    const { streak, currentResult, breakProb } = detectStreakAndBreak(history);
    if (streak >= 4) {
        if (breakProb > 0.75) return currentResult === 'Tài' ? 2 : 1;
        return currentResult === 'Tài' ? 1 : 2;
    }
    const last12 = history.slice(-12).map(h => h.result);
    if (!last12.length) return 0;
    const taiCount = last12.filter(r => r === 'Tài').length;
    const xiuCount = last12.length - taiCount;
    const deviation = Math.abs(taiCount - xiuCount) / last12.length;
    if (deviation < 0.35) return last12[last12.length - 1] === 'Xỉu' ? 1 : 2;
    return xiuCount > taiCount ? 1 : 2;
}

function recentSwitch(history) {
    if (!history || history.length < 3) return 0;
    const { streak, currentResult, breakProb } = detectStreakAndBreak(history);
    if (streak >= 4) {
        if (breakProb > 0.75) return currentResult === 'Tài' ? 2 : 1;
        return currentResult === 'Tài' ? 1 : 2;
    }
    const last10 = history.slice(-10).map(h => h.result);
    if (!last10.length) return 0;
    const switches = last10.slice(1).reduce((count, curr, idx) => count + (curr !== last10[idx] ? 1 : 0), 0);
    return switches >= 6 ? (last10[last10.length - 1] === 'Xỉu' ? 1 : 2) : (last10[last10.length - 1] === 'Xỉu' ? 1 : 2);
}

function isBadPattern(history) {
    if (!history || history.length < 3) return false;
    const last15 = history.slice(-15).map(h => h.result);
    if (!last15.length) return false;
    const switches = last15.slice(1).reduce((count, curr, idx) => count + (curr !== last15[idx] ? 1 : 0), 0);
    const { streak } = detectStreakAndBreak(history);
    return switches >= 9 || streak >= 10;
}

function aiHtddLogic(history) {
    if (!history || history.length < 3) {
        const randomResult = Math.random() < 0.5 ? 'Tài' : 'Xỉu';
        return { prediction: randomResult, reason: '[AI] Không đủ lịch sử, dự đoán ngẫu nhiên', source: 'tiendataox AI' };
    }
    const recentHistory = history.slice(-5).map(h => h.result);
    const recentScores = history.slice(-5).map(h => h.totalScore || 0);
    const taiCount = recentHistory.filter(r => r === 'Tài').length;
    const xiuCount = recentHistory.filter(r => r === 'Xỉu').length;

    if (history.length >= 3) {
        const last3 = history.slice(-3).map(h => h.result);
        if (last3.join(',') === 'Tài,Xỉu,Tài') {
            return { prediction: 'Xỉu', reason: '[tiendataox AI] Phát hiện mẫu 1T1X → tiếp theo nên đánh Xỉu', source: 'tiendataox AI' };
        } else if (last3.join(',') === 'Xỉu,Tài,Xỉu') {
            return { prediction: 'Tài', reason: '[tiendataox AI] Phát hiện mẫu 1X1T → tiếp theo nên đánh Tài', source: 'tiendataox AI' };
        }
    }
    if (history.length >= 4) {
        const last4 = history.slice(-4).map(h => h.result);
        if (last4.join(',') === 'Tài,Tài,Xỉu,Xỉu') {
            return { prediction: 'Tài', reason: '[tiendataox AI] Phát hiện mẫu 2T2X → tiếp theo nên đánh Tài', source: 'tiendataox AI' };
        } else if (last4.join(',') === 'Xỉu,Xỉu,Tài,Tài') {
            return { prediction: 'Xỉu', reason: '[tiendataox AI] Phát hiện mẫu 2X2T → tiếp theo nên đánh Xỉu', source: 'tiendataox AI' };
        }
    }
    if (history.length >= 9 && history.slice(-6).every(h => h.result === 'Tài')) {
        return { prediction: 'Xỉu', reason: '[tiendataox AI] Chuỗi Tài quá dài (6 lần) → dự đoán Xỉu', source: 'tiendataox AI' };
    } else if (history.length >= 9 && history.slice(-6).every(h => h.result === 'Xỉu')) {
        return { prediction: 'Tài', reason: '[tiendataox AI] Chuỗi Xỉu quá dài (6 lần) → dự đoán Tài', source: 'tiendataox AI' };
    }
    const avgScore = recentScores.reduce((sum, score) => sum + score, 0) / (recentScores.length || 1);
    if (avgScore > 10) {
        return { prediction: 'Tài', reason: `[tiendataox AI] Điểm trung bình cao (${avgScore.toFixed(1)}) → dự đoán Tài`, source: 'tiendataox AI' };
    } else if (avgScore < 8) {
        return { prediction: 'Xỉu', reason: `[tiendataox AI] Điểm trung bình thấp (${avgScore.toFixed(1)}) → dự đoán Xỉu`, source: 'tiendataox AI' };
    }
    if (taiCount > xiuCount + 1) {
        return { prediction: 'Xỉu', reason: `[tiendataox AI] Tài chiếm đa số (${taiCount}/${recentHistory.length}) → dự đoán Xỉu`, source: 'tiendataox AI' };
    } else if (xiuCount > taiCount + 1) {
        return { prediction: 'Tài', reason: `[tiendataox AI] Xỉu chiếm đa số (${xiuCount}/${recentHistory.length}) → dự đoán Tài`, source: 'tiendataox AI' };
    } else {
        const overallTai = history.filter(h => h.result === 'Tài').length;
        const overallXiu = history.filter(h => h.result === 'Xỉu').length;
        if (overallTai > overallXiu + 2) {
            return { prediction: 'Xỉu', reason: '[tiendataox AI] Tổng thể Tài nhiều hơn → dự đoán Xỉu', source: 'tiendataox AI' };
        } else if (overallXiu > overallTai + 2) {
            return { prediction: 'Tài', reason: '[tiendataox AI] Tổng thể Xỉu nhiều hơn → dự đoán Tài', source: 'tiendataox AI' };
        } else {
            return { prediction: Math.random() < 0.5 ? 'Tài' : 'Xỉu', reason: '[tiendataox AI] Cân bằng, dự đoán ngẫu nhiên', source: 'tiendataox AI' };
        }
    }
}

// Model predictions lưu trữ cho evaluateModelPerformance
let modelPredictions = {
    trend: {},
    short: {},
    mean: {},
    switch: {},
    bridge: {}
};

function generatePrediction(history) {
    if (!history || history.length === 0) {
        return { prediction: 'Chờ dữ liệu', confidence: 0, reason: 'Không có lịch sử' };
    }
    if (history.length < 6) {
        return { prediction: 'Chờ đủ 6 phiên', confidence: 0, reason: 'Chưa đủ dữ liệu' };
    }

    const currentIndex = history[history.length - 1].session;

    const trendPred = trendAndProb(history);
    const shortPred = shortPattern(history);
    const meanPred = meanDeviation(history);
    const switchPred = recentSwitch(history);
    const bridgePred = smartBridgeBreak(history);
    const aiPred = aiHtddLogic(history);

    modelPredictions.trend[currentIndex] = trendPred;
    modelPredictions.short[currentIndex] = shortPred;
    modelPredictions.mean[currentIndex] = meanPred;
    modelPredictions.switch[currentIndex] = switchPred;
    modelPredictions.bridge[currentIndex] = bridgePred.prediction;

    const modelScores = {
        trend: evaluateModelPerformance(history, 'trend'),
        short: evaluateModelPerformance(history, 'short'),
        mean: evaluateModelPerformance(history, 'mean'),
        switch: evaluateModelPerformance(history, 'switch'),
        bridge: evaluateModelPerformance(history, 'bridge')
    };

    const weights = {
        trend: 0.2 * modelScores.trend,
        short: 0.2 * modelScores.short,
        mean: 0.25 * modelScores.mean,
        switch: 0.2 * modelScores.switch,
        bridge: 0.15 * modelScores.bridge,
        aihtdd: 0.2
    };

    let taiScore = 0, xiuScore = 0;

    if (trendPred === 1) taiScore += weights.trend; else if (trendPred === 2) xiuScore += weights.trend;
    if (shortPred === 1) taiScore += weights.short; else if (shortPred === 2) xiuScore += weights.short;
    if (meanPred === 1) taiScore += weights.mean; else if (meanPred === 2) xiuScore += weights.mean;
    if (switchPred === 1) taiScore += weights.switch; else if (switchPred === 2) xiuScore += weights.switch;
    if (bridgePred.prediction === 1) taiScore += weights.bridge; else if (bridgePred.prediction === 2) xiuScore += weights.bridge;
    if (aiPred.prediction === 'Tài') taiScore += weights.aihtdd; else xiuScore += weights.aihtdd;

    if (isBadPattern(history)) {
        taiScore *= 0.8;
        xiuScore *= 0.8;
    }

    const last10Preds = history.slice(-10).map(h => h.result);
    const taiPredCount = last10Preds.filter(r => r === 'Tài').length;
    if (taiPredCount >= 7) xiuScore += 0.15;
    else if (taiPredCount <= 3) taiScore += 0.15;

    if (bridgePred.breakProb > 0.65) {
        if (bridgePred.prediction === 1) taiScore += 0.2;
        else xiuScore += 0.2;
    }

    const finalPrediction = taiScore > xiuScore ? 'Tài' : 'Xỉu';
    const confidence = Math.abs(taiScore - xiuScore) / (taiScore + xiuScore + 0.0001) * 100;
    const confidenceText = confidence >= 75 ? 'Rất cao' : (confidence >= 50 ? 'Cao' : 'Thấp');

    return {
        prediction: finalPrediction,
        confidence: Math.round(confidence),
        confidenceText: `${confidenceText} (${Math.round(confidence)}%)`,
        details: {
            scores: { taiScore, xiuScore },
            modelVotes: { trendPred, shortPred, meanPred, switchPred, bridgePred, aiPred },
            reason: `${aiPred.reason} | ${bridgePred.reason}`
        }
    };
}

// ==================== CÁC HÀM DỰ ĐOÁN MỚI (TỪ CODE 2) ====================
// Các hàm phụ trợ
function calculateStdDev(arr) {
    if (arr.length < 2) return 0;
    const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
    const variance = arr.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / arr.length;
    return Math.sqrt(variance);
}

function getDiceFrequencies(history, limit) {
    const allDice = [];
    const effectiveHistory = history.slice(0, limit);
    effectiveHistory.forEach(s => {
        allDice.push(s.d1, s.d2, s.d3);
    });
    const diceFreq = new Array(7).fill(0);
    allDice.forEach(d => {
        if (d >= 1 && d <= 6) diceFreq[d]++;
    });
    return diceFreq;
}

// Logic 1
function predictLogic1(lastSession, history) {
    if (!lastSession || history.length < 10) return null;
    const lastDigitOfSession = lastSession.sid % 10;
    const totalPreviousSession = lastSession.totalScore;
    let indicatorSum = lastDigitOfSession + totalPreviousSession;
    const currentPrediction = indicatorSum % 2 === 0 ? "Xỉu" : "Tài";
    let correctCount = 0;
    let totalCount = 0;
    const consistencyWindow = Math.min(history.length - 1, 25);
    for (let i = 0; i < consistencyWindow; i++) {
        const session = history[i];
        const prevSession = history[i + 1];
        if (prevSession) {
            const prevIndicatorSum = (prevSession.sid % 10) + prevSession.totalScore;
            const prevPredicted = prevIndicatorSum % 2 === 0 ? "Xỉu" : "Tài";
            if (prevPredicted === session.result) correctCount++;
            totalCount++;
        }
    }
    if (totalCount > 5 && (correctCount / totalCount) >= 0.65) return currentPrediction;
    return null;
}

// Logic 2
function predictLogic2(nextSessionId, history) {
    if (history.length < 15) return null;
    let thuanScore = 0;
    let nghichScore = 0;
    const analysisWindow = Math.min(history.length, 60);
    for (let i = 0; i < analysisWindow; i++) {
        const session = history[i];
        const isEvenSID = session.sid % 2 === 0;
        const weight = 1.0 - (i / analysisWindow) * 0.6;
        if ((isEvenSID && session.result === "Xỉu") || (!isEvenSID && session.result === "Tài")) thuanScore += weight;
        if ((isEvenSID && session.result === "Tài") || (!isEvenSID && session.result === "Xỉu")) nghichScore += weight;
    }
    const currentSessionIsEven = nextSessionId % 2 === 0;
    const totalScore = thuanScore + nghichScore;
    if (totalScore < 10) return null;
    const thuanRatio = thuanScore / totalScore;
    const nghichRatio = nghichScore / totalScore;
    if (thuanRatio > nghichRatio + 0.15) return currentSessionIsEven ? "Xỉu" : "Tài";
    if (nghichRatio > thuanRatio + 0.15) return currentSessionIsEven ? "Tài" : "Xỉu";
    return null;
}

// Logic 3
function predictLogic3(history) {
    if (history.length < 15) return null;
    const analysisWindow = Math.min(history.length, 50);
    const lastXTotals = history.slice(0, analysisWindow).map(s => s.totalScore);
    const sumOfTotals = lastXTotals.reduce((a, b) => a + b, 0);
    const average = sumOfTotals / analysisWindow;
    const stdDev = calculateStdDev(lastXTotals);
    const deviationFactor = 0.8;
    const recentTrendLength = Math.min(5, history.length);
    const recentTrend = history.slice(0, recentTrendLength).map(s => s.totalScore);
    let isRising = false, isFalling = false;
    if (recentTrendLength >= 3) {
        isRising = true; isFalling = true;
        for (let i = 0; i < recentTrendLength - 1; i++) {
            if (recentTrend[i] <= recentTrend[i + 1]) isRising = false;
            if (recentTrend[i] >= recentTrend[i + 1]) isFalling = false;
        }
    }
    if (average < 10.5 - (deviationFactor * stdDev) && isFalling) return "Xỉu";
    if (average > 10.5 + (deviationFactor * stdDev) && isRising) return "Tài";
    return null;
}

// Logic 4
function predictLogic4(history) {
    if (history.length < 30) return null;
    let bestPrediction = null;
    let maxConfidence = 0;
    const volatility = calculateStdDev(history.slice(0, Math.min(30, history.length)).map(s => s.totalScore));
    const patternLengths = (volatility < 1.7) ? [6, 5, 4] : [5, 4, 3];
    for (const len of patternLengths) {
        if (history.length < len + 2) continue;
        const recentPattern = history.slice(0, len).map(s => s.result).reverse().join('');
        let taiFollows = 0, xiuFollows = 0, totalMatches = 0;
        for (let i = len; i < Math.min(history.length - 1, 200); i++) {
            const patternToMatch = history.slice(i, i + len).map(s => s.result).reverse().join('');
            if (patternToMatch === recentPattern) {
                totalMatches++;
                const nextResult = history[i - 1].result;
                if (nextResult === 'Tài') taiFollows++; else xiuFollows++;
            }
        }
        if (totalMatches < 3) continue;
        const taiConfidence = taiFollows / totalMatches;
        const xiuConfidence = xiuFollows / totalMatches;
        const MIN_PATTERN_CONFIDENCE = 0.70;
        if (taiConfidence >= MIN_PATTERN_CONFIDENCE && taiConfidence > maxConfidence) {
            maxConfidence = taiConfidence;
            bestPrediction = "Tài";
        } else if (xiuConfidence >= MIN_PATTERN_CONFIDENCE && xiuConfidence > maxConfidence) {
            maxConfidence = xiuConfidence;
            bestPrediction = "Xỉu";
        }
    }
    return bestPrediction;
}

// Logic 5
function predictLogic5(history) {
    if (history.length < 40) return null;
    const sumCounts = {};
    const analysisWindow = Math.min(history.length, 400);
    for (let i = 0; i < analysisWindow; i++) {
        const total = history[i].totalScore;
        const weight = 1.0 - (i / analysisWindow) * 0.8;
        sumCounts[total] = (sumCounts[total] || 0) + weight;
    }
    let mostFrequentSum = -1, maxWeightedCount = 0;
    for (const sum in sumCounts) {
        if (sumCounts[sum] > maxWeightedCount) {
            maxWeightedCount = sumCounts[sum];
            mostFrequentSum = parseInt(sum);
        }
    }
    if (mostFrequentSum !== -1) {
        const totalWeightedSum = Object.values(sumCounts).reduce((a, b) => a + b, 0);
        if (totalWeightedSum > 0 && (maxWeightedCount / totalWeightedSum) > 0.08) {
            const neighbors = [];
            if (sumCounts[mostFrequentSum - 1]) neighbors.push(sumCounts[mostFrequentSum - 1]);
            if (sumCounts[mostFrequentSum + 1]) neighbors.push(sumCounts[mostFrequentSum + 1]);
            const isPeak = neighbors.every(n => maxWeightedCount > n * 1.05);
            if (isPeak) {
                if (mostFrequentSum <= 10) return "Xỉu";
                if (mostFrequentSum >= 11) return "Tài";
            }
        }
    }
    return null;
}

// Logic 6
function predictLogic6(lastSession, history) {
    if (!lastSession || history.length < 40) return null;
    const nextSessionLastDigit = (lastSession.sid + 1) % 10;
    const lastSessionTotalParity = lastSession.totalScore % 2;
    let taiVotes = 0, xiuVotes = 0;
    const analysisWindow = Math.min(history.length, 250);
    if (analysisWindow < 2) return null;
    for (let i = 0; i < analysisWindow - 1; i++) {
        const currentHistSessionResult = history[i].result;
        const prevHistSession = history[i + 1];
        const prevSessionLastDigit = prevHistSession.sid % 10;
        const prevSessionTotalParity = prevHistSession.totalScore % 2;
        const featureSetHistory = `${prevSessionLastDigit % 2}-${prevSessionTotalParity}-${(prevHistSession.totalScore > 10.5 ? 'T' : 'X')}`;
        const featureSetCurrent = `${nextSessionLastDigit % 2}-${lastSessionTotalParity}-${(lastSession.totalScore > 10.5 ? 'T' : 'X')}`;
        if (featureSetHistory === featureSetCurrent) {
            if (currentHistSessionResult === "Tài") taiVotes++; else xiuVotes++;
        }
    }
    const totalVotes = taiVotes + xiuVotes;
    if (totalVotes < 5) return null;
    const voteDifferenceRatio = Math.abs(taiVotes - xiuVotes) / totalVotes;
    if (voteDifferenceRatio > 0.25) {
        if (taiVotes > xiuVotes) return "Tài";
        if (xiuVotes > taiVotes) return "Xỉu";
    }
    return null;
}

// Logic 7
function predictLogic7(history) {
    const TREND_STREAK_LENGTH_MIN = 4;
    const TREND_STREAK_LENGTH_MAX = 7;
    if (history.length < TREND_STREAK_LENGTH_MIN) return null;
    const volatility = calculateStdDev(history.slice(0, Math.min(25, history.length)).map(s => s.totalScore));
    const effectiveStreakLength = (volatility < 1.6) ? TREND_STREAK_LENGTH_MAX : TREND_STREAK_LENGTH_MIN + 1;
    const recentResults = history.slice(0, effectiveStreakLength).map(s => s.result);
    if (recentResults.length < effectiveStreakLength) return null;
    if (recentResults.every(r => r === "Tài")) {
        const nextFew = history.slice(effectiveStreakLength, effectiveStreakLength + 2);
        if (nextFew.length === 2 && nextFew.filter(s => s.result === "Tài").length >= 1) return "Tài";
    }
    if (recentResults.every(r => r === "Xỉu")) {
        const nextFew = history.slice(effectiveStreakLength, effectiveStreakLength + 2);
        if (nextFew.length === 2 && nextFew.filter(s => s.result === "Xỉu").length >= 1) return "Xỉu";
    }
    return null;
}

// Logic 8
function predictLogic8(history) {
    const LONG_PERIOD = 30;
    if (history.length < LONG_PERIOD + 1) return null;
    const longTermTotals = history.slice(1, LONG_PERIOD + 1).map(s => s.totalScore);
    const longTermAverage = longTermTotals.reduce((a, b) => a + b, 0) / longTermTotals.length;
    const longTermStdDev = calculateStdDev(longTermTotals);
    const lastSessionTotal = history[0].totalScore;
    const dynamicDeviationThreshold = Math.max(1.5, 0.8 * longTermStdDev);
    const last5Totals = history.slice(0, Math.min(5, history.length)).map(s => s.totalScore);
    let isLast5Rising = false, isLast5Falling = false;
    if (last5Totals.length >= 2) {
        isLast5Rising = true; isLast5Falling = true;
        for (let i = 0; i < last5Totals.length - 1; i++) {
            if (last5Totals[i] <= last5Totals[i + 1]) isLast5Rising = false;
            if (last5Totals[i] >= last5Totals[i + 1]) isLast5Falling = false;
        }
    }
    if (lastSessionTotal > longTermAverage + dynamicDeviationThreshold && isLast5Rising) return "Xỉu";
    if (lastSessionTotal < longTermAverage - dynamicDeviationThreshold && isLast5Falling) return "Tài";
    return null;
}

// Logic 9
function predictLogic9(history) {
    if (history.length < 20) return null;
    let maxTaiStreak = 0, maxXiuStreak = 0;
    let currentTaiStreakForHistory = 0, currentXiuStreakForHistory = 0;
    const historyForMaxStreak = history.slice(0, Math.min(history.length, 120));
    for (const session of historyForMaxStreak) {
        if (session.result === "Tài") {
            currentTaiStreakForHistory++;
            currentXiuStreakForHistory = 0;
        } else {
            currentXiuStreakForHistory++;
            currentTaiStreakForHistory = 0;
        }
        maxTaiStreak = Math.max(maxTaiStreak, currentTaiStreakForHistory);
        maxXiuStreak = Math.max(maxXiuStreak, currentXiuStreakForHistory);
    }
    const dynamicThreshold = Math.max(4, Math.floor(Math.max(maxTaiStreak, maxXiuStreak) * 0.5));
    const mostRecentResult = history[0].result;
    let currentConsecutiveCount = 0;
    for (let i = 0; i < history.length; i++) {
        if (history[i].result === mostRecentResult) currentConsecutiveCount++;
        else break;
    }
    if (currentConsecutiveCount >= dynamicThreshold && currentConsecutiveCount >= 3) {
        let totalReversals = 0, totalContinuations = 0;
        for (let i = currentConsecutiveCount; i < history.length - currentConsecutiveCount; i++) {
            const potentialStreak = history.slice(i, i + currentConsecutiveCount);
            if (potentialStreak.every(s => s.result === mostRecentResult)) {
                if (history[i - 1] && history[i - 1].result !== mostRecentResult) totalReversals++;
                else if (history[i - 1] && history[i - 1].result === mostRecentResult) totalContinuations++;
            }
        }
        if (totalReversals + totalContinuations > 3 && totalReversals > totalContinuations * 1.3) {
            return mostRecentResult === "Tài" ? "Xỉu" : "Tài";
        }
    }
    return null;
}

// Logic 10
function predictLogic10(history) {
    const MOMENTUM_STREAK_LENGTH = 3;
    const STABILITY_CHECK_LENGTH = 7;
    if (history.length < STABILITY_CHECK_LENGTH + 1) return null;
    const recentResults = history.slice(0, MOMENTUM_STREAK_LENGTH).map(s => s.result);
    const widerHistory = history.slice(0, STABILITY_CHECK_LENGTH).map(s => s.result);
    if (recentResults.every(r => r === "Tài")) {
        const taiCountInWider = widerHistory.filter(r => r === "Tài").length;
        if (taiCountInWider / STABILITY_CHECK_LENGTH >= 0.75 && predictLogic9(history) !== "Xỉu") return "Tài";
    }
    if (recentResults.every(r => r === "Xỉu")) {
        const xiuCountInWider = widerHistory.filter(r => r === "Xỉu").length;
        if (xiuCountInWider / STABILITY_CHECK_LENGTH >= 0.75 && predictLogic9(history) !== "Tài") return "Xỉu";
    }
    return null;
}

// Logic 11
function predictLogic11(history) {
    if (history.length < 15) return null;
    const reversalPatterns = [
        { pattern: "TàiXỉuTài", predict: "Xỉu", minOccurrences: 3, weight: 1.5 },
        { pattern: "XỉuTàiXỉu", predict: "Tài", minOccurrences: 3, weight: 1.5 },
        { pattern: "TàiTàiXỉu", predict: "Tài", minOccurrences: 4, weight: 1.3 },
        { pattern: "XỉuXỉuTài", predict: "Xỉu", minOccurrences: 4, weight: 1.3 },
        { pattern: "TàiXỉuXỉu", predict: "Tài", minOccurrences: 3, weight: 1.4 },
        { pattern: "XỉuTàiTài", predict: "Xỉu", minOccurrences: 3, weight: 1.4 },
        { pattern: "XỉuTàiTàiXỉu", predict: "Xỉu", minOccurrences: 2, weight: 1.6 },
        { pattern: "TàiXỉuXỉuTài", predict: "Tài", minOccurrences: 2, weight: 1.6 },
        { pattern: "TàiXỉuTàiXỉu", predict: "Tài", minOccurrences: 2, weight: 1.4 },
        { pattern: "XỉuTàiXỉuTài", predict: "Xỉu", minOccurrences: 2, weight: 1.4 },
        { pattern: "TàiXỉuXỉuXỉu", predict: "Tài", minOccurrences: 1, weight: 1.7 },
        { pattern: "XỉuTàiTàiTài", predict: "Xỉu", minOccurrences: 1, weight: 1.7 },
    ];
    let bestPatternMatch = null, maxWeightedConfidence = 0;
    for (const patternDef of reversalPatterns) {
        const patternDefShort = patternDef.pattern.replace(/Tài/g, 'T').replace(/Xỉu/g, 'X');
        const patternLength = patternDefShort.length;
        if (history.length < patternLength + 1) continue;
        const currentWindowShort = history.slice(0, patternLength).map(s => s.result === 'Tài' ? 'T' : 'X').reverse().join('');
        if (currentWindowShort === patternDefShort) {
            let matchCount = 0, totalPatternOccurrences = 0;
            for (let i = patternLength; i < Math.min(history.length - 1, 350); i++) {
                const historicalPatternShort = history.slice(i, i + patternLength).map(s => s.result === 'Tài' ? 'T' : 'X').reverse().join('');
                if (historicalPatternShort === patternDefShort) {
                    totalPatternOccurrences++;
                    if (history[i - 1].result === patternDef.predict) matchCount++;
                }
            }
            if (totalPatternOccurrences < patternDef.minOccurrences) continue;
            const patternAccuracy = matchCount / totalPatternOccurrences;
            if (patternAccuracy >= 0.68) {
                const weightedConfidence = patternAccuracy * patternDef.weight;
                if (weightedConfidence > maxWeightedConfidence) {
                    maxWeightedConfidence = weightedConfidence;
                    bestPatternMatch = patternDef.predict;
                }
            }
        }
    }
    return bestPatternMatch;
}

// Logic 12
function predictLogic12(lastSession, history) {
    if (!lastSession || history.length < 20) return null;
    const nextSessionParity = (lastSession.sid + 1) % 2;
    const mostRecentResult = history[0].result;
    let currentConsecutiveCount = 0;
    for (let i = 0; i < history.length; i++) {
        if (history[i].result === mostRecentResult) currentConsecutiveCount++;
        else break;
    }
    let taiVotes = 0, xiuVotes = 0;
    const analysisWindow = Math.min(history.length, 250);
    for (let i = 0; i < analysisWindow - 1; i++) {
        const currentHistSession = history[i];
        const prevHistSession = history[i + 1];
        const prevHistSessionParity = prevHistSession.sid % 2;
        let histConsecutiveCount = 0;
        for (let j = i + 1; j < analysisWindow; j++) {
            if (history[j].result === prevHistSession.result) histConsecutiveCount++;
            else break;
        }
        if (prevHistSessionParity === nextSessionParity && histConsecutiveCount === currentConsecutiveCount) {
            if (currentHistSession.result === "Tài") taiVotes++;
            else xiuVotes++;
        }
    }
    const totalVotes = taiVotes + xiuVotes;
    if (totalVotes < 6) return null;
    if (taiVotes / totalVotes >= 0.68) return "Tài";
    if (xiuVotes / totalVotes >= 0.68) return "Xỉu";
    return null;
}

// Logic 13
function predictLogic13(history) {
    if (history.length < 80) return null;
    const mostRecentResult = history[0].result;
    let currentStreakLength = 0;
    for (let i = 0; i < history.length; i++) {
        if (history[i].result === mostRecentResult) currentStreakLength++;
        else break;
    }
    if (currentStreakLength < 1) return null;
    const streakStats = {};
    const analysisWindow = Math.min(history.length, 500);
    for (let i = 0; i < analysisWindow - 1; i++) {
        const sessionResult = history[i].result;
        const prevSessionResult = history[i + 1].result;
        let tempStreakLength = 1;
        for (let j = i + 2; j < analysisWindow; j++) {
            if (history[j].result === prevSessionResult) tempStreakLength++;
            else break;
        }
        if (tempStreakLength > 0) {
            const streakKey = `${prevSessionResult}_${tempStreakLength}`;
            if (!streakStats[streakKey]) streakStats[streakKey] = { 'Tài': 0, 'Xỉu': 0 };
            streakStats[streakKey][sessionResult]++;
        }
    }
    const currentStreakKey = `${mostRecentResult}_${currentStreakLength}`;
    if (streakStats[currentStreakKey]) {
        const stats = streakStats[currentStreakKey];
        const totalFollowUps = stats['Tài'] + stats['Xỉu'];
        if (totalFollowUps < 5) return null;
        const taiProb = stats['Tài'] / totalFollowUps;
        const xiuProb = stats['Xỉu'] / totalFollowUps;
        if (taiProb >= 0.65) return "Tài";
        if (xiuProb >= 0.65) return "Xỉu";
    }
    return null;
}

// Logic 14
function predictLogic14(history) {
    if (history.length < 50) return null;
    const shortPeriod = 8;
    const longPeriod = 30;
    if (history.length < longPeriod) return null;
    const shortTermTotals = history.slice(0, shortPeriod).map(s => s.totalScore);
    const longTermTotals = history.slice(0, longPeriod).map(s => s.totalScore);
    const shortAvg = shortTermTotals.reduce((a, b) => a + b, 0) / shortPeriod;
    const longAvg = longTermTotals.reduce((a, b) => a + b, 0) / longPeriod;
    const longStdDev = calculateStdDev(longTermTotals);
    if (shortAvg > longAvg + (longStdDev * 0.8)) {
        const last2Results = history.slice(0, 2).map(s => s.result);
        if (last2Results.length === 2 && last2Results.every(r => r === "Tài")) return "Xỉu";
    } else if (shortAvg < longAvg - (longStdDev * 0.8)) {
        const last2Results = history.slice(0, 2).map(s => s.result);
        if (last2Results.length === 2 && last2Results.every(r => r === "Xỉu")) return "Tài";
    }
    return null;
}

// Logic 15
function predictLogic15(history) {
    if (history.length < 80) return null;
    const analysisWindow = Math.min(history.length, 400);
    const evenCounts = { "Tài": 0, "Xỉu": 0 };
    const oddCounts = { "Tài": 0, "Xỉu": 0 };
    let totalEven = 0, totalOdd = 0;
    for (let i = 0; i < analysisWindow; i++) {
        const session = history[i];
        const isTotalEven = session.totalScore % 2 === 0;
        if (isTotalEven) {
            evenCounts[session.result]++;
            totalEven++;
        } else {
            oddCounts[session.result]++;
            totalOdd++;
        }
    }
    if (totalEven < 20 || totalOdd < 20) return null;
    const lastSessionTotal = history[0].totalScore;
    const isLastTotalEven = lastSessionTotal % 2 === 0;
    const minDominance = 0.65;
    if (isLastTotalEven) {
        if (evenCounts["Tài"] / totalEven >= minDominance) return "Tài";
        if (evenCounts["Xỉu"] / totalEven >= minDominance) return "Xỉu";
    } else {
        if (oddCounts["Tài"] / totalOdd >= minDominance) return "Tài";
        if (oddCounts["Xỉu"] / totalOdd >= minDominance) return "Xỉu";
    }
    return null;
}

// Logic 16
function predictLogic16(history) {
    if (history.length < 60) return null;
    const MODULO_N = 5;
    const analysisWindow = Math.min(history.length, 500);
    const moduloPatterns = {};
    for (let i = 0; i < analysisWindow - 1; i++) {
        const prevSession = history[i + 1];
        const currentSessionResult = history[i].result;
        const moduloValue = prevSession.totalScore % MODULO_N;
        if (!moduloPatterns[moduloValue]) moduloPatterns[moduloValue] = { 'Tài': 0, 'Xỉu': 0 };
        moduloPatterns[moduloValue][currentSessionResult]++;
    }
    const lastSessionTotal = history[0].totalScore;
    const currentModuloValue = lastSessionTotal % MODULO_N;
    if (moduloPatterns[currentModuloValue]) {
        const stats = moduloPatterns[currentModuloValue];
        const totalCount = stats['Tài'] + stats['Xỉu'];
        if (totalCount < 7) return null;
        const taiProb = stats['Tài'] / totalCount;
        const xiuProb = stats['Xỉu'] / totalCount;
        if (taiProb >= 0.65) return "Tài";
        if (xiuProb >= 0.65) return "Xỉu";
    }
    return null;
}

// Logic 17
function predictLogic17(history) {
    if (history.length < 100) return null;
    const analysisWindow = Math.min(history.length, 600);
    const totals = history.slice(0, analysisWindow).map(s => s.totalScore);
    const meanTotal = totals.reduce((a, b) => a + b, 0) / totals.length;
    const stdDevTotal = calculateStdDev(totals);
    const lastSessionTotal = history[0].totalScore;
    const deviation = Math.abs(lastSessionTotal - meanTotal);
    const zScore = stdDevTotal > 0 ? deviation / stdDevTotal : 0;
    if (zScore >= 1.5) {
        if (lastSessionTotal > meanTotal) return "Xỉu";
        else return "Tài";
    }
    return null;
}

// Logic 18
function predictLogic18(history) {
    if (history.length < 50) return null;
    const analysisWindow = Math.min(history.length, 300);
    const patternStats = {};
    for (let i = 0; i < analysisWindow - 1; i++) {
        const prevSession = history[i + 1];
        const currentSessionResult = history[i].result;
        const p1 = prevSession.d1 % 2, p2 = prevSession.d2 % 2, p3 = prevSession.d3 % 2;
        const patternKey = `${p1}-${p2}-${p3}`;
        if (!patternStats[patternKey]) patternStats[patternKey] = { 'Tài': 0, 'Xỉu': 0 };
        patternStats[patternKey][currentSessionResult]++;
    }
    const lastSession = history[0];
    const currentP1 = lastSession.d1 % 2, currentP2 = lastSession.d2 % 2, currentP3 = lastSession.d3 % 2;
    const currentPatternKey = `${currentP1}-${currentP2}-${currentP3}`;
    if (patternStats[currentPatternKey]) {
        const stats = patternStats[currentPatternKey];
        const totalCount = stats['Tài'] + stats['Xỉu'];
        if (totalCount < 8) return null;
        const taiProb = stats['Tài'] / totalCount;
        const xiuProb = stats['Xỉu'] / totalCount;
        if (taiProb >= 0.65) return "Tài";
        if (xiuProb >= 0.65) return "Xỉu";
    }
    return null;
}

// Logic 19
function predictLogic19(history) {
    if (history.length < 50) return null;
    let taiScore = 0, xiuScore = 0;
    const now = Date.now();
    const analysisWindowMs = 2 * 60 * 60 * 1000;
    for (const session of history) {
        if (now - session.timestamp > analysisWindowMs) break;
        const ageFactor = 1 - ((now - session.timestamp) / analysisWindowMs);
        const weight = ageFactor * ageFactor * ageFactor;
        if (session.result === "Tài") taiScore += weight;
        else xiuScore += weight;
    }
    const totalScore = taiScore + xiuScore;
    if (totalScore < 10) return null;
    const taiRatio = taiScore / totalScore;
    const xiuRatio = xiuScore / totalScore;
    if (taiRatio > xiuRatio + 0.10) return "Tài";
    if (xiuRatio > taiRatio + 0.10) return "Xỉu";
    return null;
}

// Logic 21: Multi-Window V3
function markovWeightedV3(patternArr) {
    if (patternArr.length < 3) return null;
    const transitions = {};
    const lastResult = patternArr[patternArr.length - 1];
    const secondLastResult = patternArr.length > 1 ? patternArr[patternArr.length - 2] : null;
    for (let i = 0; i < patternArr.length - 1; i++) {
        const current = patternArr[i];
        const next = patternArr[i + 1];
        const key = current + next;
        if (!transitions[key]) transitions[key] = { 'T': 0, 'X': 0 };
        if (i + 2 < patternArr.length) transitions[key][patternArr[i + 2]]++;
    }
    if (secondLastResult && lastResult) {
        const currentTransitionKey = secondLastResult + lastResult;
        if (transitions[currentTransitionKey]) {
            const stats = transitions[currentTransitionKey];
            const total = stats['T'] + stats['X'];
            if (total > 3) {
                if (stats['T'] / total > 0.60) return "Tài";
                if (stats['X'] / total > 0.60) return "Xỉu";
            }
        }
    }
    return null;
}

function repeatingPatternV3(patternArr) {
    if (patternArr.length < 4) return null;
    const lastThree = patternArr.slice(-3).join('');
    const lastFour = patternArr.slice(-4).join('');
    let taiFollows = 0, xiuFollows = 0, totalMatches = 0;
    for (let i = 0; i < patternArr.length - 4; i++) {
        const sliceThree = patternArr.slice(i, i + 3).join('');
        const sliceFour = patternArr.slice(i, i + 4).join('');
        let isMatch = false;
        if (lastThree === sliceThree) isMatch = true;
        else if (lastFour === sliceFour) isMatch = true;
        if (isMatch && i + 4 < patternArr.length) {
            totalMatches++;
            if (patternArr[i + 4] === 'T') taiFollows++; else xiuFollows++;
        }
    }
    if (totalMatches < 3) return null;
    if (taiFollows / totalMatches > 0.65) return "Tài";
    if (xiuFollows / totalMatches > 0.65) return "Xỉu";
    return null;
}

function detectBiasV3(patternArr) {
    if (patternArr.length < 5) return null;
    let taiCount = 0, xiuCount = 0;
    patternArr.forEach(result => {
        if (result === 'T') taiCount++; else xiuCount++;
    });
    const total = taiCount + xiuCount;
    if (total === 0) return null;
    const taiRatio = taiCount / total;
    const xiuRatio = xiuCount / total;
    if (taiRatio > 0.60) return "Tài";
    if (xiuRatio > 0.60) return "Xỉu";
    return null;
}

function predictLogic21(history) {
    if (history.length < 20) return null;
    const patternArr = history.map(s => s.result === 'Tài' ? 'T' : 'X');
    const voteCounts = { Tài: 0, Xỉu: 0 };
    let totalWeightSum = 0;
    const windows = [3, 5, 8, 12, 20, 30, 40, 60, 80];
    for (const win of windows) {
        if (patternArr.length < win) continue;
        const subPattern = patternArr.slice(0, win);
        const weight = win / 10;
        const markovRes = markovWeightedV3(subPattern.slice().reverse());
        if (markovRes) {
            voteCounts[markovRes] += weight * 0.7;
            totalWeightSum += weight * 0.7;
        }
        const repeatRes = repeatingPatternV3(subPattern.slice().reverse());
        if (repeatRes) {
            voteCounts[repeatRes] += weight * 0.15;
            totalWeightSum += weight * 0.15;
        }
        const biasRes = detectBiasV3(subPattern);
        if (biasRes) {
            voteCounts[biasRes] += weight * 0.15;
            totalWeightSum += weight * 0.15;
        }
    }
    if (totalWeightSum === 0) return null;
    if (voteCounts.Tài > voteCounts.Xỉu * 1.08) return "Tài";
    if (voteCounts.Xỉu > voteCounts.Tài * 1.08) return "Xỉu";
    return null;
}

// Logic 22: Super-powered Cau Analysis Logic
function predictLogic22(history, cauLogData) {
    if (history.length < 15) return null;
    const resultsOnly = history.map(s => s.result === 'Tài' ? 'T' : 'X');
    const totalsOnly = history.map(s => s.totalScore);
    let taiVotes = 0, xiuVotes = 0, totalContributionWeight = 0;
    const currentStreakResult = resultsOnly[0];
    let currentStreakLength = 0;
    for (let i = 0; i < resultsOnly.length; i++) {
        if (resultsOnly[i] === currentStreakResult) currentStreakLength++;
        else break;
    }
    if (currentStreakLength >= 3) {
        let streakBreakCount = 0, streakContinueCount = 0;
        const streakSearchWindow = Math.min(resultsOnly.length, 200);
        for (let i = currentStreakLength; i < streakSearchWindow; i++) {
            const potentialStreak = resultsOnly.slice(i, i + currentStreakLength);
            if (potentialStreak.every(r => r === currentStreakResult)) {
                if (resultsOnly[i - 1]) {
                    if (resultsOnly[i - 1] === currentStreakResult) streakContinueCount++;
                    else streakBreakCount++;
                }
            }
        }
        const totalStreakOccurrences = streakBreakCount + streakContinueCount;
        if (totalStreakOccurrences > 5) {
            if (streakBreakCount / totalStreakOccurrences > 0.65) {
                if (currentStreakResult === 'T') xiuVotes += 1.5; else taiVotes += 1.5;
                totalContributionWeight += 1.5;
            } else if (streakContinueCount / totalStreakOccurrences > 0.65) {
                if (currentStreakResult === 'T') taiVotes += 1.5; else xiuVotes += 1.5;
                totalContributionWeight += 1.5;
            }
        }
    }
    if (history.length >= 4) {
        const lastFour = resultsOnly.slice(0, 4).join('');
        let patternMatches = 0, taiFollows = 0, xiuFollows = 0;
        const patternToMatch = lastFour.substring(0, 3);
        const searchLength = Math.min(resultsOnly.length, 150);
        for (let i = 0; i < searchLength - 3; i++) {
            const historicalPattern = resultsOnly.slice(i, i + 3).join('');
            if (historicalPattern === patternToMatch) {
                if (resultsOnly[i + 3] === 'T') taiFollows++;
                else xiuFollows++;
                patternMatches++;
            }
        }
        if (patternMatches > 4) {
            if (taiFollows / patternMatches > 0.70) { taiVotes += 1.2; totalContributionWeight += 1.2; }
            else if (xiuFollows / patternMatches > 0.70) { xiuVotes += 1.2; totalContributionWeight += 1.2; }
        }
    }
    if (totalContributionWeight === 0) return null;
    if (taiVotes > xiuVotes * 1.1) return "Tài";
    if (xiuVotes > taiVotes * 1.1) return "Xỉu";
    return null;
}

// Logic 23: New combined formulas
function predictLogic23(history) {
    if (history.length < 5) return null;
    const totals = history.map(s => s.totalScore);
    const allDice = history.slice(0, Math.min(history.length, 10)).flatMap(s => [s.d1, s.d2, s.d3]);
    const diceFreq = getDiceFrequencies(history, 10);
    const avg_total = totals.slice(0, Math.min(history.length, 10)).reduce((a, b) => a + b, 0) / Math.min(history.length, 10);
    const simplePredictions = [];
    if (history.length >= 2) {
        if ((totals[0] + totals[1]) % 2 === 0) simplePredictions.push("Tài"); else simplePredictions.push("Xỉu");
    }
    if (avg_total > 10.5) simplePredictions.push("Tài"); else simplePredictions.push("Xỉu");
    if (diceFreq[4] + diceFreq[5] > diceFreq[1] + diceFreq[2]) simplePredictions.push("Tài"); else simplePredictions.push("Xỉu");
    if (history.filter(s => s.totalScore > 10).length > history.length / 2) simplePredictions.push("Tài"); else simplePredictions.push("Xỉu");
    if (history.length >= 3) {
        if (totals.slice(0, 3).reduce((a, b) => a + b, 0) > 33) simplePredictions.push("Tài"); else simplePredictions.push("Xỉu");
    }
    if (history.length >= 5) {
        if (Math.max(...totals.slice(0, 5)) > 15) simplePredictions.push("Tài"); else simplePredictions.push("Xỉu");
    }
    if (history.length >= 5) {
        if (totals.slice(0, 5).filter(t => t > 10).length >= 3) simplePredictions.push("Tài"); else simplePredictions.push("Xỉu");
    }
    if (history.length >= 3) {
        if (totals.slice(0, 3).reduce((a, b) => a + b, 0) > 34) simplePredictions.push("Tài"); else simplePredictions.push("Xỉu");
    }
    if (history.length >= 2) {
        if (totals[0] > 10 && totals[1] > 10) simplePredictions.push("Tài"); else simplePredictions.push("Xỉu");
        if (totals[0] < 10 && totals[1] < 10) simplePredictions.push("Xỉu"); else simplePredictions.push("Tài");
    }
    if (history.length >= 1) {
        if ((totals[0] + diceFreq[3]) % 2 === 0) simplePredictions.push("Tài"); else simplePredictions.push("Xỉu");
        if (diceFreq[2] > 3) simplePredictions.push("Tài"); else simplePredictions.push("Xỉu");
        if ([11, 12, 13].includes(totals[0])) simplePredictions.push("Tài"); else simplePredictions.push("Xỉu");
    }
    if (history.length >= 2) {
        if (totals[0] + totals[1] > 30) simplePredictions.push("Tài"); else simplePredictions.push("Xỉu");
    }
    if (allDice.filter(d => d > 3).length > 7) simplePredictions.push("Tài"); else simplePredictions.push("Xỉu");
    if (history.length >= 1) {
        if (totals[0] % 2 === 0) simplePredictions.push("Tài"); else simplePredictions.push("Xỉu");
    }
    if (allDice.filter(d => d > 3).length > 8) simplePredictions.push("Tài"); else simplePredictions.push("Xỉu");
    if (history.length >= 3) {
        if (totals.slice(0, 3).reduce((a, b) => a + b, 0) % 4 === 0) simplePredictions.push("Tài"); else simplePredictions.push("Xỉu");
        if (totals.slice(0, 3).reduce((a, b) => a + b, 0) % 3 === 0) simplePredictions.push("Tài"); else simplePredictions.push("Xỉu");
    }
    if (history.length >= 1) {
        if (totals[0] % 3 === 0) simplePredictions.push("Tài"); else simplePredictions.push("Xỉu");
        if (totals[0] % 5 === 0) simplePredictions.push("Tài"); else simplePredictions.push("Xỉu");
        if (totals[0] % 4 === 0) simplePredictions.push("Tài"); else simplePredictions.push("Xỉu");
    }
    if (diceFreq[4] > 2) simplePredictions.push("Tài"); else simplePredictions.push("Xỉu");
    let taiVotes = 0, xiuVotes = 0;
    simplePredictions.forEach(p => { if (p === "Tài") taiVotes++; else if (p === "Xỉu") xiuVotes++; });
    if (taiVotes > xiuVotes * 1.5) return "Tài";
    if (xiuVotes > taiVotes * 1.5) return "Xỉu";
    return null;
}

const PATTERN_DATA = {
    "ttxttx": { tai: 80, xiu: 20 }, "xxttxx": { tai: 25, xiu: 75 },
    "ttxxtt": { tai: 75, xiu: 25 }, "txtxt": { tai: 60, xiu: 40 },
    "xtxtx": { tai: 40, xiu: 60 }, "ttx": { tai: 70, xiu: 30 },
    "xxt": { tai: 30, xiu: 70 }, "txt": { tai: 65, xiu: 35 },
    "xtx": { tai: 35, xiu: 65 }, "tttt": { tai: 85, xiu: 15 },
    "xxxx": { tai: 15, xiu: 85 }, "ttttt": { tai: 88, xiu: 12 },
    "xxxxx": { tai: 12, xiu: 88 }, "tttttt": { tai: 92, xiu: 8 },
    "xxxxxx": { tai: 8, xiu: 92 }, "tttx": { tai: 75, xiu: 25 },
    "xxxt": { tai: 25, xiu: 75 }, "ttxtx": { tai: 78, xiu: 22 },
    "xxtxt": { tai: 22, xiu: 78 }, "txtxtx": { tai: 82, xiu: 18 },
    "xtxtxt": { tai: 18, xiu: 82 }, "ttxtxt": { tai: 85, xiu: 15 },
    "xxtxtx": { tai: 15, xiu: 85 }, "txtxxt": { tai: 83, xiu: 17 },
    "xtxttx": { tai: 17, xiu: 83 }, "ttttttt": { tai: 95, xiu: 5 },
    "xxxxxxx": { tai: 5, xiu: 95 }, "tttttttt": { tai: 97, xiu: 3 },
    "xxxxxxxx": { tai: 3, xiu: 97 }, "txtx": { tai: 60, xiu: 40 },
    "xtxt": { tai: 40, xiu: 60 }, "txtxt": { tai: 65, xiu: 35 },
    "xtxtx": { tai: 35, xiu: 65 }, "txtxtxt": { tai: 70, xiu: 30 },
    "xtxtxtx": { tai: 30, xiu: 70 }
};

function analyzePatterns(lastResults) {
    if (!lastResults || lastResults.length === 0) return [null, "Không có dữ liệu"];
    const resultsShort = lastResults.map(r => r === "Tài" ? "T" : "X");
    const displayLength = Math.min(resultsShort.length, 10);
    const recentSequence = resultsShort.slice(0, displayLength).join('');
    return [null, `: ${recentSequence}`];
}

function predictLogic24(history) {
    if (!history || history.length < 5) return null;
    const lastResults = history.map(s => s.result);
    const totals = history.map(s => s.totalScore);
    const allDice = history.flatMap(s => [s.d1, s.d2, s.d3]);
    const diceFreq = new Array(7).fill(0);
    allDice.forEach(d => { if (d >= 1 && d <= 6) diceFreq[d]++; });
    const avg_total = totals.slice(0, Math.min(history.length, 10)).reduce((a, b) => a + b, 0) / Math.min(history.length, 10);
    const votes = [];
    if (history.length >= 2) {
        if ((totals[0] + totals[1]) % 2 === 0) votes.push("Tài"); else votes.push("Xỉu");
    }
    if (avg_total > 10.5) votes.push("Tài"); else votes.push("Xỉu");
    if (diceFreq[4] + diceFreq[5] > diceFreq[1] + diceFreq[2]) votes.push("Tài"); else votes.push("Xỉu");
    if (history.filter(s => s.totalScore > 10).length > history.length / 2) votes.push("Tài"); else votes.push("Xỉu");
    if (history.length >= 3) {
        if (totals.slice(0, 3).reduce((a, b) => a + b, 0) > 33) votes.push("Tài"); else votes.push("Xỉu");
    }
    if (history.length >= 5) {
        if (Math.max(...totals.slice(0, 5)) > 15) votes.push("Tài"); else votes.push("Xỉu");
    }
    const patternSeq = lastResults.slice(0, 3).reverse().map(r => r === "Tài" ? "t" : "x").join("");
    if (PATTERN_DATA[patternSeq]) {
        const prob = PATTERN_DATA[patternSeq];
        if (prob.tai > prob.xiu + 15) votes.push("Tài");
        else if (prob.xiu > prob.tai + 15) votes.push("Xỉu");
    }
    const [patternPred, patternDesc] = analyzePatterns(lastResults);
    if (patternPred) votes.push(patternPred);
    const taiCount = votes.filter(v => v === "Tài").length;
    const xiuCount = votes.filter(v => v === "Xỉu").length;
    if (taiCount + xiuCount < 4) return null;
    if (taiCount >= xiuCount + 3) return "Tài";
    if (xiuCount >= taiCount + 3) return "Xỉu";
    return null;
}

// Logic 20: Meta-Logic (Ensemble) – cần truyền cauLogData, ở đây dùng mảng rỗng
let logicPerformance = {
    logic1: { correct: 0, total: 0, accuracy: 0, consistency: 0, lastPredicted: null, lastActual: null },
    logic2: { correct: 0, total: 0, accuracy: 0, consistency: 0, lastPredicted: null, lastActual: null },
    logic3: { correct: 0, total: 0, accuracy: 0, consistency: 0, lastPredicted: null, lastActual: null },
    logic4: { correct: 0, total: 0, accuracy: 0, consistency: 0, lastPredicted: null, lastActual: null },
    logic5: { correct: 0, total: 0, accuracy: 0, consistency: 0, lastPredicted: null, lastActual: null },
    logic6: { correct: 0, total: 0, accuracy: 0, consistency: 0, lastPredicted: null, lastActual: null },
    logic7: { correct: 0, total: 0, accuracy: 0, consistency: 0, lastPredicted: null, lastActual: null },
    logic8: { correct: 0, total: 0, accuracy: 0, consistency: 0, lastPredicted: null, lastActual: null },
    logic9: { correct: 0, total: 0, accuracy: 0, consistency: 0, lastPredicted: null, lastActual: null },
    logic10: { correct: 0, total: 0, accuracy: 0, consistency: 0, lastPredicted: null, lastActual: null },
    logic11: { correct: 0, total: 0, accuracy: 0, consistency: 0, lastPredicted: null, lastActual: null },
    logic12: { correct: 0, total: 0, accuracy: 0, consistency: 0, lastPredicted: null, lastActual: null },
    logic13: { correct: 0, total: 0, accuracy: 0, consistency: 0, lastPredicted: null, lastActual: null },
    logic14: { correct: 0, total: 0, accuracy: 0, consistency: 0, lastPredicted: null, lastActual: null },
    logic15: { correct: 0, total: 0, accuracy: 0, consistency: 0, lastPredicted: null, lastActual: null },
    logic16: { correct: 0, total: 0, accuracy: 0, consistency: 0, lastPredicted: null, lastActual: null },
    logic17: { correct: 0, total: 0, accuracy: 0, consistency: 0, lastPredicted: null, lastActual: null },
    logic18: { correct: 0, total: 0, accuracy: 0, consistency: 0, lastPredicted: null, lastActual: null },
    logic19: { correct: 0, total: 0, accuracy: 0, consistency: 0, lastPredicted: null, lastActual: null },
    logic20: { correct: 0, total: 0, accuracy: 0, consistency: 0, lastPredicted: null, lastActual: null },
    logic21: { correct: 0, total: 0, accuracy: 0, consistency: 0, lastPredicted: null, lastActual: null },
    logic22: { correct: 0, total: 0, accuracy: 0, consistency: 0, lastPredicted: null, lastActual: null },
    logic23: { correct: 0, total: 0, accuracy: 0, consistency: 0, lastPredicted: null, lastActual: null },
    logic24: { correct: 0, total: 0, accuracy: 0, consistency: 0, lastPredicted: null, lastActual: null }
};

function updateLogicPerformance(logicName, predicted, actual) {
    if (predicted === null || !logicPerformance[logicName]) return;
    const currentAcc = logicPerformance[logicName].accuracy;
    const currentTotal = logicPerformance[logicName].total;
    let dynamicDecayFactor = 0.95;
    if (currentTotal > 0 && currentAcc < 0.60) dynamicDecayFactor = 0.85;
    else if (currentTotal > 0 && currentAcc > 0.80) dynamicDecayFactor = 0.98;
    logicPerformance[logicName].correct = logicPerformance[logicName].correct * dynamicDecayFactor;
    logicPerformance[logicName].total = logicPerformance[logicName].total * dynamicDecayFactor;
    logicPerformance[logicName].total++;
    let wasCorrect = 0;
    if (predicted === actual) { logicPerformance[logicName].correct++; wasCorrect = 1; }
    logicPerformance[logicName].accuracy = logicPerformance[logicName].total > 0 ? (logicPerformance[logicName].correct / logicPerformance[logicName].total) : 0;
    const adaptiveAlphaConsistency = (currentAcc < 0.6) ? 0.3 : 0.1;
    logicPerformance[logicName].consistency = (logicPerformance[logicName].consistency * (1 - adaptiveAlphaConsistency)) + (wasCorrect * adaptiveAlphaConsistency);
    if (logicPerformance[logicName].total < 20 && logicPerformance[logicName].accuracy > 0.90) logicPerformance[logicName].accuracy = 0.90;
    else if (logicPerformance[logicName].total < 50 && logicPerformance[logicName].accuracy > 0.95) logicPerformance[logicName].accuracy = 0.95;
    logicPerformance[logicName].lastPredicted = predicted;
    logicPerformance[logicName].lastActual = actual;
}

function analyzeAndExtractPatterns(history) {
    const patterns = {};
    if (history.length >= 2) {
        patterns.sum_sequence_patterns = [
            { key: `${history[0].totalScore}-${history[0].result === 'Tài' ? 'T' : 'X'}_${history[1]?.totalScore}-${history[1]?.result === 'Tài' ? 'T' : 'X'}` }
        ];
    }
    if (history.length >= 1) {
        let currentStreakLength = 0;
        const currentResult = history[0].result;
        for (let i = 0; i < history.length; i++) {
            if (history[i].result === currentResult) currentStreakLength++;
            else break;
        }
        if (currentStreakLength > 0) {
            patterns.last_streak = { result: currentResult === 'Tài' ? 'T' : 'X', length: currentStreakLength };
        }
    }
    if (history.length >= 3) {
        const resultsShort = history.slice(0, 3).map(s => s.result === 'Tài' ? 'T' : 'X').join('');
        if (resultsShort === 'TXT' || resultsShort === 'XTX') patterns.alternating_pattern = resultsShort;
    }
    return patterns;
}

async function predictLogic20(history, logicPerformance, cauLogData) {
    if (history.length < 30) return null;
    let taiVotes = 0, xiuVotes = 0;
    const signals = [
        { logic: 'logic1', baseWeight: 0.8 }, { logic: 'logic2', baseWeight: 0.7 }, { logic: 'logic3', baseWeight: 0.9 },
        { logic: 'logic4', baseWeight: 1.2 }, { logic: 'logic5', baseWeight: 0.6 }, { logic: 'logic6', baseWeight: 0.8 },
        { logic: 'logic7', baseWeight: 1.0 }, { logic: 'logic8', baseWeight: 0.7 }, { logic: 'logic9', baseWeight: 1.1 },
        { logic: 'logic10', baseWeight: 0.9 }, { logic: 'logic11', baseWeight: 1.3 }, { logic: 'logic12', baseWeight: 0.7 },
        { logic: 'logic13', baseWeight: 1.2 }, { logic: 'logic14', baseWeight: 0.8 }, { logic: 'logic15', baseWeight: 0.6 },
        { logic: 'logic16', baseWeight: 0.7 }, { logic: 'logic17', baseWeight: 0.9 }, { logic: 'logic18', baseWeight: 1.3 },
        { logic: 'logic19', baseWeight: 0.9 }, { logic: 'logic21', baseWeight: 1.5 }, { logic: 'logic22', baseWeight: 1.8 },
        { logic: 'logic23', baseWeight: 1.0 }, { logic: 'logic24', baseWeight: 1.1 }
    ];
    const lastSession = history[0];
    const nextSessionId = lastSession.sid + 1;
    const childPredictions = {
        logic1: predictLogic1(lastSession, history),
        logic2: predictLogic2(nextSessionId, history),
        logic3: predictLogic3(history),
        logic4: predictLogic4(history),
        logic5: predictLogic5(history),
        logic6: predictLogic6(lastSession, history),
        logic7: predictLogic7(history),
        logic8: predictLogic8(history),
        logic9: predictLogic9(history),
        logic10: predictLogic10(history),
        logic11: predictLogic11(history),
        logic12: predictLogic12(lastSession, history),
        logic13: predictLogic13(history),
        logic14: predictLogic14(history),
        logic15: predictLogic15(history),
        logic16: predictLogic16(history),
        logic17: predictLogic17(history),
        logic18: predictLogic18(history),
        logic19: predictLogic19(history),
        logic21: predictLogic21(history),
        logic22: predictLogic22(history, cauLogData),
        logic23: predictLogic23(history),
        logic24: predictLogic24(history),
    };
    signals.forEach(signal => {
        const prediction = childPredictions[signal.logic];
        if (prediction !== null && logicPerformance[signal.logic]) {
            const acc = logicPerformance[signal.logic].accuracy;
            const consistency = logicPerformance[signal.logic].consistency;
            if (logicPerformance[signal.logic].total > 3 && acc > 0.35 && consistency > 0.25) {
                const effectiveWeight = signal.baseWeight * ((acc + consistency) / 2);
                if (prediction === "Tài") taiVotes += effectiveWeight;
                else xiuVotes += effectiveWeight;
            }
        }
    });
    const totalWeightedVotes = taiVotes + xiuVotes;
    if (totalWeightedVotes < 1.5) return null;
    if (taiVotes > xiuVotes * 1.08) return "Tài";
    if (xiuVotes > taiVotes * 1.08) return "Xỉu";
    return null;
}

// ==================== HÀM DỰ ĐOÁN TỔNG HỢP (Kết hợp tất cả) ====================
let currentPrediction = {
    prediction: 'Chờ đủ dữ liệu',
    confidence: 0,
    details: {}
};

async function generateAdvancedPrediction(history) {
    if (!history || history.length < 6) {
        return { prediction: 'Chờ đủ 6 phiên', confidence: 0, confidenceText: 'N/A', details: { reason: 'Chưa đủ dữ liệu' } };
    }

    // 1. Dự đoán từ các logic cũ (trend, short, mean, switch, bridge, aiHtdd)
    const oldPred = generatePrediction(history);

    // 2. Dự đoán từ các logic mới (1-24) thông qua logic20
    // Tạo một mảng cauLogData rỗng vì không dùng file log
    const cauLogData = [];
    const metaPred = await predictLogic20(history, logicPerformance, cauLogData);

    // 3. Kết hợp: nếu metaPred có thì ưu tiên, nếu không dùng oldPred, nếu cả hai đều có thì so sánh độ tin cậy
    let finalPrediction = oldPred.prediction;
    let finalConfidence = oldPred.confidence;
    let finalConfidenceText = oldPred.confidenceText;
    let reason = oldPred.details.reason;

    if (metaPred) {
        // Có thể ưu tiên metaPred nếu độ tin cậy cao hơn hoặc nếu oldPred có độ tin cậy thấp
        // Đơn giản: dùng metaPred nếu nó khác oldPred và oldPred độ tin cậy < 70
        if (oldPred.confidence < 70) {
            finalPrediction = metaPred;
            finalConfidence = 75; // Giả định độ tin cậy trung bình
            finalConfidenceText = 'Cao (75%)';
            reason = `Dự đoán từ Meta-Logic (${metaPred}) do độ tin cậy của logic cũ thấp.`;
        } else {
            // Nếu cả hai đều có thể kết hợp
            finalPrediction = metaPred;
            finalConfidence = (oldPred.confidence + 75) / 2;
            finalConfidenceText = `Trung bình (${Math.round(finalConfidence)}%)`;
            reason = `Kết hợp từ Meta-Logic và logic cũ.`;
        }
    }

    return {
        prediction: finalPrediction,
        confidence: Math.round(finalConfidence),
        confidenceText: finalConfidenceText,
        details: { reason, oldPred, metaPred }
    };
}

// ==================== WEBSOCKET CLIENT ====================
const initialMessages = [
    [
        1,
        "MiniGame",
        "GM_apivopnhaan",
        "WangLin",
        {
            "info": "{\"ipAddress\":\"113.185.45.88\",\"wsToken\":\"eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJnZW5kZXIiOjAsImNhblZpZXdTdGF0IjpmYWxzZSwiZGlzcGxheU5hbWUiOiJwbGFtYW1hIiwiYm90IjowLCJpc01lcmNoYW50IjpmYWxzZSwidmVyaWZpZWRCYW5rQWNjb3VudCI6ZmFsc2UsInBsYXlFdmVudExvYmJ5IjpmYWxzZSwiY3VzdG9tZXJJZCI6MzMxNDgxMTYyLCJhZmZJZCI6IkdFTVdJTiIsImJhbm5lZCI6ZmFsc2UsImJyYW5kIjoiZ2VtIiwidGltZXN0YW1wIjoxNzY2NDc0NzgwMDA2LCJsb2NrR2FtZXMiOltdLCJhbW91bnQiOjAsImxvY2tDaGF0IjpmYWxzZSwicGhvbmVWZXJpZmllZCI6ZmFsc2UsImlwQWRkcmVzcyI6IjExMy4xODUuNDUuODgiLCJtdXRlIjpmYWxzZSwiYXZhdGFyIjoiaHR0cHM6Ly9pbWFnZXMuc3dpbnNob3AubmV0L2ltYWdlcy9hdmF0YXIvYXZhdGFyXzE4LnBuZyIsInBsYXRmb3JtSWQiOjUsInVzZXJJZCI6IjZhOGI0ZDM4LTFlYzEtNDUxYi1hYTA1LWYyZDkwYWFhNGM1MCIsInJlZ1RpbWUiOjE3NjY0NzQ3NTEzOTEsInBob25lIjoiIiwiZGVwb3NpdCI6ZmFsc2UsInVzZXJuYW1lIjoiR01fYXBpdm9wbmhhYW4ifQ.YFOscbeojWNlRo7490BtlzkDGYmwVpnlgOoh04oCJy4\",\"locale\":\"vi\",\"userId\":\"6a8b4d38-1ec1-451b-aa05-f2d90aaa4c50\",\"username\":\"GM_apivopnhaan\",\"timestamp\":1766474780007,\"refreshToken\":\"63d5c9be0c494b74b53ba150d69039fd.7592f06d63974473b4aaa1ea849b2940\"}",
            "signature": "66772A1641AA8B18BD99207CE448EA00ECA6D8A4D457C1FF13AB092C22C8DECF0C0014971639A0FBA9984701A91FCCBE3056ABC1BE1541D1C198AA18AF3C45595AF6601F8B048947ADF8F48A9E3E074162F9BA3E6C0F7543D38BD54FD4C0A2C56D19716CC5353BBC73D12C3A92F78C833F4EFFDC4AB99E55C77AD2CDFA91E296"
        }
    ],
    [6, "MiniGame", "taixiuPlugin", { cmd: 1005 }],
    [6, "MiniGame", "lobbyPlugin", { cmd: 10001 }]
];

function connectWebSocket() {
    if (ws) {
        ws.removeAllListeners();
        ws.close();
    }

    ws = new WebSocket(WS_URL, { headers: WS_HEADERS });

    ws.on('open', () => {
        console.log('[✅] WebSocket connected to Sun.Win');
        initialMessages.forEach((msg, i) => {
            setTimeout(() => {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify(msg));
                }
            }, i * 600);
        });

        clearInterval(pingInterval);
        pingInterval = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.ping();
            }
        }, PING_INTERVAL);
    });

    ws.on('pong', () => {});

    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
            if (!Array.isArray(data) || typeof data[1] !== 'object') return;

            const { cmd, sid, d1, d2, d3, gBB } = data[1];

            if (cmd === 1008 && sid) {
                currentSessionId = sid;
                console.log(`[🎮] Phiên mới: ${sid}`);
            }

            if (cmd === 1003 && gBB) {
                if (!d1 || !d2 || !d3) return;

                const total = d1 + d2 + d3;
                const result = (total > 10) ? "Tài" : "Xỉu";
                const now = new Date().toISOString();
                const timestamp = Date.now();

                apiResponseData = {
                    "Phien": currentSessionId,
                    "Xuc_xac_1": d1,
                    "Xuc_xac_2": d2,
                    "Xuc_xac_3": d3,
                    "Tong": total,
                    "Ket_qua": result,
                    "id": "@tiendataox",
                    "server_time": now,
                    "update_count": (apiResponseData.update_count || 0) + 1
                };

                console.log(`[🎲] Phiên ${apiResponseData.Phien}: ${d1}-${d2}-${d3} = ${total} (${result})`);

                // Lưu vào patternHistory
                patternHistory.push({
                    session: currentSessionId,
                    dice: [d1, d2, d3],
                    total: total,
                    result: result,
                    timestamp: now
                });
                if (patternHistory.length > MAX_HISTORY) patternHistory.shift();

                // Lưu vào historyForPrediction (đủ dice)
                historyForPrediction.push({
                    session: currentSessionId,
                    result: result,
                    totalScore: total,
                    d1: d1,
                    d2: d2,
                    d3: d3,
                    timestamp: timestamp
                });
                if (historyForPrediction.length > MAX_PREDICTION_HISTORY) historyForPrediction.shift();

                // Cập nhật hiệu suất logic dựa trên phiên vừa qua (nếu có phiên trước)
                if (historyForPrediction.length >= 2) {
                    const lastSession = historyForPrediction[1]; // phiên trước đó
                    const actual = historyForPrediction[0].result; // kết quả vừa nhận
                    // Dự đoán từ logic1-24 (lưu ý cần có lastSession và nextSessionId cho phiên trước)
                    // Ta có thể cập nhật logicPerformance cho từng logic
                    const nextSessionIdForPrev = lastSession.session + 1;
                    const pred1 = predictLogic1(lastSession, historyForPrediction.slice(1));
                    const pred2 = predictLogic2(nextSessionIdForPrev, historyForPrediction.slice(1));
                    const pred3 = predictLogic3(historyForPrediction.slice(1));
                    const pred4 = predictLogic4(historyForPrediction.slice(1));
                    const pred5 = predictLogic5(historyForPrediction.slice(1));
                    const pred6 = predictLogic6(lastSession, historyForPrediction.slice(1));
                    const pred7 = predictLogic7(historyForPrediction.slice(1));
                    const pred8 = predictLogic8(historyForPrediction.slice(1));
                    const pred9 = predictLogic9(historyForPrediction.slice(1));
                    const pred10 = predictLogic10(historyForPrediction.slice(1));
                    const pred11 = predictLogic11(historyForPrediction.slice(1));
                    const pred12 = predictLogic12(lastSession, historyForPrediction.slice(1));
                    const pred13 = predictLogic13(historyForPrediction.slice(1));
                    const pred14 = predictLogic14(historyForPrediction.slice(1));
                    const pred15 = predictLogic15(historyForPrediction.slice(1));
                    const pred16 = predictLogic16(historyForPrediction.slice(1));
                    const pred17 = predictLogic17(historyForPrediction.slice(1));
                    const pred18 = predictLogic18(historyForPrediction.slice(1));
                    const pred19 = predictLogic19(historyForPrediction.slice(1));
                    const pred21 = predictLogic21(historyForPrediction.slice(1));
                    const pred22 = predictLogic22(historyForPrediction.slice(1), []);
                    const pred23 = predictLogic23(historyForPrediction.slice(1));
                    const pred24 = predictLogic24(historyForPrediction.slice(1));
                    const allPreds = [
                        { name: 'logic1', pred: pred1 }, { name: 'logic2', pred: pred2 }, { name: 'logic3', pred: pred3 },
                        { name: 'logic4', pred: pred4 }, { name: 'logic5', pred: pred5 }, { name: 'logic6', pred: pred6 },
                        { name: 'logic7', pred: pred7 }, { name: 'logic8', pred: pred8 }, { name: 'logic9', pred: pred9 },
                        { name: 'logic10', pred: pred10 }, { name: 'logic11', pred: pred11 }, { name: 'logic12', pred: pred12 },
                        { name: 'logic13', pred: pred13 }, { name: 'logic14', pred: pred14 }, { name: 'logic15', pred: pred15 },
                        { name: 'logic16', pred: pred16 }, { name: 'logic17', pred: pred17 }, { name: 'logic18', pred: pred18 },
                        { name: 'logic19', pred: pred19 }, { name: 'logic21', pred: pred21 }, { name: 'logic22', pred: pred22 },
                        { name: 'logic23', pred: pred23 }, { name: 'logic24', pred: pred24 }
                    ];
                    allPreds.forEach(p => {
                        if (p.pred) updateLogicPerformance(p.name, p.pred, actual);
                    });
                    // Cập nhật logic20 sau khi có dự đoán từ logic20
                    const metaPred = await predictLogic20(historyForPrediction.slice(1), logicPerformance, []);
                    if (metaPred) updateLogicPerformance('logic20', metaPred, actual);
                }

                // Cập nhật dự đoán cho phiên tiếp theo
                const advancedPred = await generateAdvancedPrediction(historyForPrediction);
                currentPrediction = {
                    prediction: advancedPred.prediction,
                    confidence: advancedPred.confidence,
                    confidenceText: advancedPred.confidenceText,
                    details: advancedPred.details
                };

                console.log(`📊 Dự đoán phiên tiếp theo: ${currentPrediction.prediction} (Độ tin cậy: ${currentPrediction.confidenceText})`);

                currentSessionId = null;
            }
        } catch (e) {
            console.error('[❌] Lỗi xử lý message:', e.message);
        }
    });

    ws.on('close', (code, reason) => {
        console.log(`[🔌] WebSocket closed. Code: ${code}, Reason: ${reason.toString()}`);
        clearInterval(pingInterval);
        clearTimeout(reconnectTimeout);
        reconnectTimeout = setTimeout(connectWebSocket, RECONNECT_DELAY);
    });

    ws.on('error', (err) => {
        console.error('[❌] WebSocket error:', err.message);
        ws.close();
    });
}

// ==================== EXPRESS APP ====================
const app = express();
app.use(cors());

// ---- Endpoints từ server.js gốc ----
app.get('/api/ditmemaysun', (req, res) => {
    res.json(apiResponseData);
});

app.get('/api/history', (req, res) => {
    res.json({
        current: apiResponseData,
        history: patternHistory.slice(-20),
        total_requests: apiResponseData.update_count || 0
    });
});

app.get('/api/sunwin/history', (req, res) => {
    const last100 = patternHistory
        .slice(-100)
        .reverse()
        .map(item => ({
            "Ket_qua": item.result,
            "Phien": item.session,
            "Tong": item.total,
            "Xuc_xac_1": item.dice[0],
            "Xuc_xac_2": item.dice[1],
            "Xuc_xac_3": item.dice[2],
            "id": "@tiendataox"
        }));
    res.json(last100);
});

app.get('/api/stats', (req, res) => {
    const taiCount = patternHistory.filter(item => item.result === "Tài").length;
    const xiuCount = patternHistory.filter(item => item.result === "Xỉu").length;
    res.json({
        total_sessions: patternHistory.length,
        tai_count: taiCount,
        xiu_count: xiuCount,
        tai_percentage: patternHistory.length > 0 ? ((taiCount / patternHistory.length) * 100).toFixed(2) : 0,
        xiu_percentage: patternHistory.length > 0 ? ((xiuCount / patternHistory.length) * 100).toFixed(2) : 0,
        last_update: apiResponseData.server_time,
        server_uptime: process.uptime().toFixed(0) + 's'
    });
});

app.get('/api/health', (req, res) => {
    res.json({
        status: 'online',
        websocket: ws ? ws.readyState === WebSocket.OPEN : false,
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        connections: ws ? 'connected' : 'disconnected'
    });
});

// ---- Endpoints dự đoán (có thêm phien_hien_tai) ----
app.get('/prediction', (req, res) => {
    const lastResult = historyForPrediction.length > 0 ? historyForPrediction[0] : null;
    const nextPhien = lastResult ? lastResult.session + 1 : "Chờ...";

    if (historyForPrediction.length < 6) {
        return res.json({
            lastResult: lastResult ? {
                phien: lastResult.session,
                result: lastResult.result,
                sum: lastResult.totalScore,
                xucxac: [lastResult.d1, lastResult.d2, lastResult.d3]
            } : null,
            phien_hien_tai: nextPhien,
            Prediction: "Chờ đủ 6 phiên",
            "Độ Tin Cậy": "N/A"
        });
    }

    res.json({
        lastResult: lastResult ? {
            phien: lastResult.session,
            result: lastResult.result,
            sum: lastResult.totalScore,
            xucxac: [lastResult.d1, lastResult.d2, lastResult.d3]
        } : null,
        phien_hien_tai: nextPhien,
        Prediction: currentPrediction.prediction,
        "Độ Tin Cậy": currentPrediction.confidenceText
    });
});

app.get('/history', (req, res) => {
    const last50 = historyForPrediction.slice(-50).map(h => ({
        phien: h.session,
        result: h.result,
        sum: h.totalScore,
        xucxac: [h.d1, h.d2, h.d3],
        timestamp: h.timestamp
    }));
    res.json({ count: historyForPrediction.length, history: last50 });
});

// ---- Trang chủ ----
app.get('/', (req, res) => {
    const networkInfo = getNetworkInfo();
    const html = `
    <!DOCTYPE html>
    <html>
    <head>
        <title>Sun.Win Data Stream + Dự đoán AI (tiendataox AI)</title>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
            body { font-family: Arial, sans-serif; margin: 20px; background: #0a0a0a; color: #00ff00; }
            .container { max-width: 1200px; margin: 0 auto; }
            .header { text-align: center; padding: 20px; background: #111; border-radius: 10px; margin-bottom: 20px; }
            .data-box { background: #111; padding: 20px; border-radius: 10px; margin: 10px 0; }
            .live-data { font-size: 2em; font-weight: bold; color: #00ff00; }
            .tai { color: #00ff00; }
            .xiu { color: #ff0000; }
            .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px; }
            .status { color: #ffff00; }
            a { color: #00ffff; }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="header">
                <h1>🔴 Sun.Win Live Data + Dự đoán AI (tiendataox AI)</h1>
                <p>Worm GPT Edition - Public Access</p>
                <p>Server: ${networkInfo.localIP}:${PORT}</p>
                <p>Access from any device using this IP and port</p>
            </div>
            
            <div class="grid">
                <div class="data-box">
                    <h2>🎲 Current Result</h2>
                    <div class="live-data ${apiResponseData.Ket_qua === 'Tài' ? 'tai' : 'xiu'}">
                        ${apiResponseData.Tong ? `${apiResponseData.Xuc_xac_1}-${apiResponseData.Xuc_xac_2}-${apiResponseData.Xuc_xac_3} = ${apiResponseData.Tong} (${apiResponseData.Ket_qua})` : 'Waiting...'}
                    </div>
                    <p>Phiên: ${apiResponseData.Phien || 'N/A'}</p>
                    <p>Time: ${apiResponseData.server_time || 'N/A'}</p>
                </div>
                
                <div class="data-box">
                    <h2>🔮 Dự đoán phiên tiếp theo</h2>
                    <div class="live-data ${currentPrediction.prediction === 'Tài' ? 'tai' : 'xiu'}">
                        ${currentPrediction.prediction || 'Chờ dữ liệu'}
                    </div>
                    <p>Độ tin cậy: ${currentPrediction.confidenceText || 'N/A'}</p>
                </div>
                
                <div class="data-box">
                    <h2>📊 API Endpoints</h2>
                    <ul>
                        <li><a href="/api/ditmemaysun">/api/ditmemaysun</a> - Latest result</li>
                        <li><a href="/api/history">/api/history</a> - Last 20 results</li>
                        <li><a href="/api/sunwin/history">/api/sunwin/history</a> - Last 100 results (format mới)</li>
                        <li><a href="/api/stats">/api/stats</a> - Statistics</li>
                        <li><a href="/api/health">/api/health</a> - Server health</li>
                        <li><a href="/prediction">/prediction</a> - Dự đoán (có phien_hien_tai)</li>
                        <li><a href="/history">/history</a> - 50 kết quả gần nhất (format cũ)</li>
                    </ul>
                </div>
            </div>
            
            <div class="data-box">
                <h2>🔗 How to Access Remotely</h2>
                <p>From other devices/network, use:</p>
                <code style="background:#222;padding:10px;display:block;margin:10px 0;">
                    http://[SERVER_IP]:${PORT}/api/ditmemaysun
                </code>
                <p>Replace [SERVER_IP] with the server's public IP address</p>
            </div>
        </div>
        
        <script>
            setInterval(() => {
                fetch('/api/ditmemaysun')
                    .then(res => res.json())
                    .then(data => {
                        if(data.Tong) {
                            const resultDiv = document.querySelector('.live-data');
                            resultDiv.textContent = \`\${data.Xuc_xac_1}-\${data.Xuc_xac_2}-\${data.Xuc_xac_3} = \${data.Tong} (\${data.Ket_qua})\`;
                            resultDiv.className = \`live-data \${data.Ket_qua === 'Tài' ? 'tai' : 'xiu'}\`;
                        }
                    });
                fetch('/prediction')
                    .then(res => res.json())
                    .then(data => {
                        const predDiv = document.querySelector('.data-box:nth-child(2) .live-data');
                        if(predDiv) {
                            predDiv.textContent = data.Prediction;
                            predDiv.className = \`live-data \${data.Prediction === 'Tài' ? 'tai' : 'xiu'}\`;
                            document.querySelector('.data-box:nth-child(2) p').innerHTML = \`Độ tin cậy: \${data["Độ Tin Cậy"]}\`;
                        }
                    });
            }, 5000);
        </script>
    </body>
    </html>
    `;
    res.send(html);
});

// ==================== KHỞI ĐỘNG SERVER ====================
const server = http.createServer(app);
server.listen(PORT, '0.0.0.0', () => {
    const networkInfo = getNetworkInfo();
    console.log(`\n=========================================`);
    console.log(`🚀 WORM GPT Sun.Win Data + Prediction Server (tiendataox AI)`);
    console.log(`=========================================`);
    console.log(`📡 Server running on:`);
    console.log(`   Local: http://localhost:${PORT}`);
    console.log(`   Network: http://${networkInfo.localIP}:${PORT}`);
    console.log(`=========================================`);
    console.log(`🔌 Connecting to Sun.Win WebSocket...`);
    console.log(`💀 Worm GPT Public Access Enabled!`);
    console.log(`=========================================\n`);
    
    connectWebSocket();
});
