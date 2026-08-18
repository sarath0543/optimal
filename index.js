// ================= CONFIGURATION & GLOBAL STATE =================
const SCRIPT_URL = "https://script.google.com/macros/s/AKfycbysj9PqJEHlGitVjYJFlI3omNpikT4yghnPs5-877nGVQ1Y5BxzoA7EG6FFfvLy2iQ7Mw/exec";

let dbData = { users: [], subjects: [], schedule: [] };
let currentUser = null;
let currentActiveSubject = null;
let customRollNumbers = [];
let studentStatus = [];
let selectedConsoleSubject = null;
let isEditModeActive = false;

// Global Live Check Cache
let liveSubmittedStatus = false;
let liveSavedRecord = null;
let lastCheckedPeriodKey = "";

// Time Sync State
let networkTimeOffset = 0;
let isTimeSynced = false;

// Cached DOM References (Prevents constant DOM queries every second)
const DOM = {
    authOverlay: document.getElementById('auth-overlay'),
    pinInput: document.getElementById('pin-input'),
    pinError: document.getElementById('pin-error'),
    appContent: document.getElementById('app-content'),
    facultyView: document.getElementById('faculty-view'),
    adminView: document.getElementById('admin-view'),
    logoutBtn: document.getElementById('logout-btn'),
    roleBadge: document.getElementById('role-badge'),
    footerDock: document.getElementById('footer-dock'),
    countersContainer: document.getElementById('counters-container'),
    dynamicTitle: document.getElementById('dynamic-title'),
    liveTime: document.getElementById('live-time'),
    presentCount: document.getElementById('present-count'),
    absentCount: document.getElementById('absent-count'),
    submitBtn: document.getElementById('submit-btn'),
    attendanceGrid: document.getElementById('attendance-grid'),
    subjectCardsContainer: document.getElementById('subject-cards-container'),
    states: {
        active: document.getElementById('state-active'),
        submittedLock: document.getElementById('state-submitted-lock'),
        sunday: document.getElementById('state-sunday'),
        morningClosed: document.getElementById('state-morning-closed'),
        lunch: document.getElementById('state-lunch'),
        eveningClosed: document.getElementById('state-evening-closed'),
        noClass: document.getElementById('state-no-class')
    }
};

// Fetch authoritative time from Asia/Kolkata endpoint
async function syncNetworkTime() {
    try {
        const response = await fetch("https://worldtimeapi.org/api/timezone/Asia/Kolkata");
        const data = await response.json();
        if (data?.datetime) {
            networkTimeOffset = new Date(data.datetime).getTime() - Date.now();
            isTimeSynced = true;
            return;
        }
    } catch {
        try {
            const fallbackResponse = await fetch("https://timeapi.io/api/v1/time/current/zone?timeZone=Asia/Kolkata");
            const fallbackData = await fallbackResponse.json();
            if (fallbackData?.dateTime) {
                networkTimeOffset = new Date(fallbackData.dateTime).getTime() - Date.now();
                isTimeSynced = true;
            }
        } catch (err) {
            console.warn("Time sync error, using device clock fallback:", err);
        }
    }
}

function getAccurateDate() {
    return isTimeSynced ? new Date(Date.now() + networkTimeOffset) : new Date();
}

syncNetworkTime();
setInterval(syncNetworkTime, 5 * 60 * 1000);

const PERIOD_TIMES = [
    { period: 1, label: "1st Hour", startMins: 570, endMins: 630 },
    { period: 2, label: "2nd Hour", startMins: 630, endMins: 690 },
    { period: 3, label: "3rd Hour", startMins: 690, endMins: 750 },
    { period: 4, label: "4th Hour", startMins: 810, endMins: 870 },
    { period: 5, label: "5th Hour", startMins: 870, endMins: 930 },
    { period: 6, label: "6th Hour", startMins: 930, endMins: 990 }
];

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function getSubmissionLockKey(subjectCode, periodLabel) {
    const todayStr = getAccurateDate().toISOString().slice(0, 10);
    return `submitted_${todayStr}_${subjectCode}_${periodLabel.replace(/\s+/g, '_')}`;
}

function getDraftKey(subjectCode, periodLabel) {
    const todayStr = getAccurateDate().toISOString().slice(0, 10);
    return `draft_${todayStr}_${subjectCode}_${periodLabel.replace(/\s+/g, '_')}`;
}

function setPeriodSubmittedLock(subjectCode, periodLabel, whatsappUrl) {
    localStorage.setItem(getSubmissionLockKey(subjectCode, periodLabel), JSON.stringify({
        submittedAt: getAccurateDate().toISOString(),
        whatsappUrl: whatsappUrl || ""
    }));
}

function saveDraft(subjectCode, periodLabel) {
    if (!subjectCode || !periodLabel) return;
    localStorage.setItem(getDraftKey(subjectCode, periodLabel), JSON.stringify({
        studentStatus,
        updatedAt: getAccurateDate().toISOString()
    }));
}

function loadDraft(subjectCode, periodLabel) {
    if (!subjectCode || !periodLabel) return false;
    const saved = localStorage.getItem(getDraftKey(subjectCode, periodLabel));
    if (!saved) return false;
    try {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed.studentStatus) && parsed.studentStatus.length === studentStatus.length) {
            studentStatus = parsed.studentStatus;
            return true;
        }
    } catch (e) {
        console.error("Draft load error:", e);
    }
    return false;
}

function clearDraft(subjectCode, periodLabel) {
    if (subjectCode && periodLabel) {
        localStorage.removeItem(getDraftKey(subjectCode, periodLabel));
    }
}

async function checkLivePeriodStatus(subjectCode, periodLabel) {
    const periodKey = `${subjectCode}_${periodLabel}`;
    try {
        const response = await fetch(`${SCRIPT_URL}?action=checkStatus&subjectCode=${encodeURIComponent(subjectCode)}&period=${encodeURIComponent(periodLabel)}`);
        const data = await response.json();
        
        liveSubmittedStatus = Boolean(data.isSubmitted || data.submitted);
        liveSavedRecord = data.record || null;
        lastCheckedPeriodKey = periodKey;

        if (liveSubmittedStatus) {
            setPeriodSubmittedLock(subjectCode, periodLabel, data.whatsappUrl || "");
        } else {
            localStorage.removeItem(getSubmissionLockKey(subjectCode, periodLabel));
        }
        return liveSubmittedStatus;
    } catch (e) {
        console.error("Error fetching status:", e);
        return localStorage.getItem(getSubmissionLockKey(subjectCode, periodLabel)) !== null;
    }
}

function generateWhatsAppUrl(subjectTitle, periodLabel, customRolls, statusArray, presentRollsFromCloud) {
    let presentRolls = [];
    let totalCount = customRolls ? customRolls.length : 0;

    if (Array.isArray(presentRollsFromCloud)) {
        presentRolls = presentRollsFromCloud;
    } else if (customRolls && statusArray) {
        presentRolls = customRolls.filter((_, idx) => statusArray[idx]);
    }

    const presentListStr = presentRolls.length > 0 ? presentRolls.join(", ") : "None";
    const msg = `*${subjectTitle} < ${periodLabel} >*\n\n*Total Present:* ${presentRolls.length}/${totalCount}\n*Present Roll Numbers:* ${presentListStr}`;
    return "https://api.whatsapp.com/send?text=" + encodeURIComponent(msg);
}

async function fetchSheetDB() {
    try {
        const response = await fetch(SCRIPT_URL);
        dbData = await response.json();
    } catch (e) {
        console.error("DB Fetch Error:", e);
    }
}
window.addEventListener('DOMContentLoaded', fetchSheetDB);

async function refreshScheduleOnly() {
    try {
        const response = await fetch(`${SCRIPT_URL}?action=getSchedule`);
        const result = await response.json();
        if (result.schedule) {
            dbData.schedule = result.schedule;
            if (selectedConsoleSubject) renderScheduleGrid();
        }
    } catch (e) {
        console.error("Schedule sync error:", e);
    }
}

DOM.pinInput?.addEventListener('input', async () => {
    if (DOM.pinInput.value.length === 6) {
        const pinEntered = DOM.pinInput.value.trim();
        if (!dbData.users?.length) await fetchSheetDB();

        const matchedUser = dbData.users.find(u => String(u.PIN ?? u.pin ?? u.Pin).trim() === pinEntered);

        if (matchedUser) {
            currentUser = matchedUser;
            grantAccess();
        } else {
            DOM.pinInput.classList.add('shake-element');
            DOM.pinError.classList.remove('d-none');
            DOM.pinInput.value = "";
            setTimeout(() => DOM.pinInput.classList.remove('shake-element'), 400);
        }
    }
});

async function grantAccess() {
    DOM.authOverlay.style.opacity = '0';
    await fetchSheetDB();

    setTimeout(() => {
        DOM.authOverlay.classList.add('d-none');
        DOM.appContent.classList.remove('d-none');
        DOM.logoutBtn.classList.remove('d-none');

        const role = currentUser.Role || currentUser.role || currentUser.ROLE || 'User';
        DOM.roleBadge.innerText = `${role} Access`;

        if (role.toLowerCase() === 'admin') {
            DOM.adminView.classList.remove('d-none');
            DOM.facultyView.classList.add('d-none');
            renderAdminDashboard();
        } else {
            DOM.facultyView.classList.remove('d-none');
            DOM.adminView.classList.add('d-none');
            currentActiveSubject = null;
            lastCheckedPeriodKey = "";
            updateClock();
            setInterval(updateClock, 1000);
        }
    }, 300);
}

// ================= ADMIN PANEL LOGIC =================

function renderAdminDashboard() {
    if (!DOM.subjectCardsContainer) return;

    if (!dbData.subjects || dbData.subjects.length === 0) {
        DOM.subjectCardsContainer.innerHTML = `<div class="col-12 text-center text-muted">No subjects found in database.</div>`;
        return;
    }

    DOM.subjectCardsContainer.innerHTML = dbData.subjects.map(subj => {
        const code = subj.SubjectCode || subj.subjectcode || '';
        const name = subj.SubjectName || subj.subjectname || '';
        const faculty = dbData.users?.find(u => 
            String(u.AssignedSubject || u.assignedsubject || '').trim().toLowerCase() === String(code).trim().toLowerCase()
        );
        const facultyName = faculty ? (faculty.Name || faculty.name || faculty.Role || 'Faculty') : 'Unassigned';

        return `
            <div class="col">
                <div onclick="openAdminConsole('${code}')" class="card h-100 border-0 shadow-sm rounded-4 p-3 hover-card cursor-pointer bg-white">
                    <div class="d-flex justify-content-between align-items-start mb-2">
                        <span class="badge bg-primary bg-opacity-10 text-primary fw-bold px-2 py-1" style="font-size: 10px;">${code}</span>
                        <span class="text-muted extra-small">⚙️ Manage</span>
                    </div>
                    <h6 class="fw-bold text-dark mb-1">${name}</h6>
                    <div class="text-secondary extra-small">Faculty: <strong class="text-dark">${facultyName}</strong></div>
                </div>
            </div>
        `;
    }).join('');
}

function openAdminConsole(subjectCode) {
    selectedConsoleSubject = dbData.subjects.find(s => 
        String(s.SubjectCode || s.subjectcode || '').trim().toLowerCase() === String(subjectCode).trim().toLowerCase()
    );

    if (!selectedConsoleSubject) return;

    const code = selectedConsoleSubject.SubjectCode || selectedConsoleSubject.subjectcode;
    const name = selectedConsoleSubject.SubjectName || selectedConsoleSubject.subjectname;
    const faculty = dbData.users?.find(u => 
        String(u.AssignedSubject || u.assignedsubject || '').trim().toLowerCase() === String(code).trim().toLowerCase()
    );

    document.getElementById('admin-dashboard')?.classList.add('d-none');
    document.getElementById('admin-subject-console')?.classList.remove('d-none');

    document.getElementById('console-subject-name').innerText = name;
    document.getElementById('console-subject-code').innerText = code;
    document.getElementById('console-subject-prof').innerText = faculty ? (faculty.Name || faculty.name || 'Assigned Faculty') : 'No Faculty Assigned';

    isEditModeActive = false;
    renderScheduleGrid();
}

function closeAdminConsole() {
    selectedConsoleSubject = null;
    isEditModeActive = false;
    document.getElementById('admin-subject-console')?.classList.add('d-none');
    document.getElementById('admin-dashboard')?.classList.remove('d-none');
    renderAdminDashboard();
}

function renderScheduleGrid() {
    const grid = document.getElementById('schedule-allocation-grid');
    if (!grid || !selectedConsoleSubject) return;

    const currentCode = selectedConsoleSubject.SubjectCode || selectedConsoleSubject.subjectcode;

    grid.innerHTML = WEEKDAYS.map(day => {
        const periodButtons = PERIOD_TIMES.map(p => {
            const isAssigned = checkScheduleAllocation(currentCode, day, p.period);
            
            if (isEditModeActive) {
                return `
                    <button type="button" 
                        onclick="toggleScheduleCell('${day}', ${p.period})" 
                        class="btn btn-sm flex-fill period-btn ${isAssigned ? 'btn-primary' : 'btn-outline-light text-dark border'}">
                        P${p.period}
                    </button>`;
            } else {
                return `
                    <span class="badge flex-fill py-2 ${isAssigned ? 'bg-primary' : 'bg-light text-muted border'}" style="font-size: 10px;">
                        P${p.period}
                    </span>`;
            }
        }).join('');

        return `
            <div class="d-flex align-items-center gap-2 p-2 bg-light rounded-3">
                <span class="fw-bold text-dark extra-small" style="width: 80px;">${day.slice(0, 3)}</span>
                <div class="d-flex gap-1 flex-grow-1">${periodButtons}</div>
            </div>
        `;
    }).join('');

    const saveContainer = document.getElementById('save-schedule-container');
    const editBtn = document.getElementById('edit-schedule-btn');

    if (saveContainer) saveContainer.classList.toggle('d-none', !isEditModeActive);
    if (editBtn) editBtn.innerText = isEditModeActive ? "✕ Cancel Editing" : "✏️ Edit Timetable";
}

function toggleScheduleEditMode() {
    isEditModeActive = !isEditModeActive;
    renderScheduleGrid();
}

function toggleScheduleCell(day, period) {
    if (!selectedConsoleSubject) return;
    const currentCode = selectedConsoleSubject.SubjectCode || selectedConsoleSubject.subjectcode;

    const existingIndex = dbData.schedule.findIndex(s => {
        const sCode = String(s.SubjectCode || s.subjectcode || '').trim().toLowerCase();
        const sDay = String(s.Day || s.day || '').trim().toLowerCase();
        const sPeriod = String(s.Period || s.period || '').replace(/\D/g, '');
        return sCode === currentCode.toLowerCase() && sDay === day.toLowerCase() && sPeriod === String(period);
    });

    if (existingIndex > -1) {
        dbData.schedule.splice(existingIndex, 1);
    } else {
        const pObj = PERIOD_TIMES.find(p => p.period === period);
        dbData.schedule.push({
            SubjectCode: currentCode,
            Day: day,
            Period: `Period ${period}`,
            StartTime: `${Math.floor(pObj.startMins/60)}:${pObj.startMins%60}`,
            EndTime: `${Math.floor(pObj.endMins/60)}:${pObj.endMins%60}`
        });
    }
    renderScheduleGrid();
}

async function saveScheduleChanges() {
    const btn = document.querySelector('#save-schedule-container button');
    if (btn) {
        btn.disabled = true;
        btn.innerText = "Saving to Cloud...";
    }

    try {
        const payload = JSON.stringify({
            action: "updateSchedule",
            schedule: dbData.schedule
        });

        await fetch(SCRIPT_URL, {
            method: "POST",
            mode: "no-cors",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: "postData=" + encodeURIComponent(payload)
        });

        alert("✅ Schedule updated successfully!");
        isEditModeActive = false;
        await refreshScheduleOnly();
    } catch (e) {
        console.error("Schedule Save Error:", e);
        alert("⚠️ Failed to update schedule.");
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerText = "Save Schedule Changes";
        }
    }
}

async function resetFacultyPIN() {
    if (!selectedConsoleSubject) return;
    const currentCode = selectedConsoleSubject.SubjectCode || selectedConsoleSubject.subjectcode;

    const newPIN = prompt(`Enter new 6-digit PIN for ${currentCode}:`);
    if (!newPIN || newPIN.trim().length !== 6 || isNaN(newPIN)) {
        alert("Invalid PIN. Must be 6 digits.");
        return;
    }

    try {
        const payload = JSON.stringify({
            action: "updatePIN",
            subjectCode: currentCode,
            newPIN: newPIN.trim()
        });

        await fetch(SCRIPT_URL, {
            method: "POST",
            mode: "no-cors",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: "postData=" + encodeURIComponent(payload)
        });

        alert(`✅ PIN updated to ${newPIN}`);
        await fetchSheetDB();
    } catch (e) {
        alert("⚠️ Could not update PIN.");
    }
}

function logoutUser() {
    currentUser = null;
    currentActiveSubject = null;
    selectedConsoleSubject = null;
    isEditModeActive = false;
    lastCheckedPeriodKey = "";

    DOM.appContent.classList.add('d-none');
    DOM.facultyView.classList.add('d-none');
    DOM.adminView.classList.add('d-none');
    DOM.logoutBtn.classList.add('d-none');

    DOM.pinInput.value = "";
    DOM.pinError.classList.add('d-none');
    DOM.authOverlay.classList.remove('d-none');
    DOM.authOverlay.style.opacity = '1';

    fetchSheetDB();
}

function hideAllStates() {
    Object.values(DOM.states).forEach(el => el?.classList.add('d-none'));
}

async function updateClock() {
    const now = getAccurateDate();
    const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const currentDay = days[now.getDay()];
    const hrs = String(now.getHours()).padStart(2, '0');
    const mins = String(now.getMinutes()).padStart(2, '0');
    const secs = String(now.getSeconds()).padStart(2, '0');
    const currentMins = now.getHours() * 60 + now.getMinutes();

    const userAssigned = currentUser ? (currentUser.AssignedSubject || currentUser.assignedsubject || '') : '';
    const subjObj = dbData.subjects.find(s => String(s.SubjectCode || s.subjectcode || '').trim().toLowerCase() === String(userAssigned).trim().toLowerCase());
    const subjectTitle = subjObj ? (subjObj.SubjectName || subjObj.subjectname || userAssigned) : (userAssigned || 'Academic Console');

    hideAllStates();

    if (currentDay === "Sunday") {
        DOM.states.sunday?.classList.remove('d-none');
        DOM.footerDock?.classList.add('d-none');
        DOM.countersContainer?.classList.add('d-none');
        if (DOM.dynamicTitle) DOM.dynamicTitle.innerText = subjectTitle;
        if (DOM.liveTime) DOM.liveTime.innerText = `${currentDay}, ${hrs}:${mins}`;
        return;
    }

    if (currentMins < 570) {
        DOM.states.morningClosed?.classList.remove('d-none');
        DOM.footerDock?.classList.add('d-none');
        DOM.countersContainer?.classList.add('d-none');
        if (DOM.dynamicTitle) DOM.dynamicTitle.innerText = subjectTitle;
        if (DOM.liveTime) DOM.liveTime.innerText = `${currentDay}, ${hrs}:${mins}`;
        return;
    }

    if (currentMins >= 750 && currentMins < 810) {
        DOM.states.lunch?.classList.remove('d-none');
        DOM.footerDock?.classList.add('d-none');
        DOM.countersContainer?.classList.add('d-none');
        if (DOM.dynamicTitle) DOM.dynamicTitle.innerText = subjectTitle;

        const remainingLunchSecs = (810 * 60) - (currentMins * 60 + parseInt(secs, 10));
        const lMins = String(Math.floor(remainingLunchSecs / 60)).padStart(2, '0');
        const lSecs = String(remainingLunchSecs % 60).padStart(2, '0');
        if (DOM.liveTime) DOM.liveTime.innerHTML = `${currentDay}, ${hrs}:${mins} • <strong class="text-warning">Lunch Break (${lMins}:${lSecs})</strong>`;
        return;
    }

    if (currentMins >= 990) {
        DOM.states.eveningClosed?.classList.remove('d-none');
        DOM.footerDock?.classList.add('d-none');
        DOM.countersContainer?.classList.add('d-none');
        if (DOM.dynamicTitle) DOM.dynamicTitle.innerText = subjectTitle;
        if (DOM.liveTime) DOM.liveTime.innerText = `${currentDay}, ${hrs}:${mins}`;
        return;
    }

    const activePeriod = PERIOD_TIMES.find(p => currentMins >= p.startMins && currentMins < p.endMins);

    if (activePeriod && checkScheduleAllocation(userAssigned, currentDay, activePeriod.period)) {
        const currentPeriodKey = `${userAssigned}_${activePeriod.label}`;

        if (currentActiveSubject !== userAssigned) {
            currentActiveSubject = userAssigned;
            loadRolls(currentActiveSubject, activePeriod.label);
        }

        if (lastCheckedPeriodKey !== currentPeriodKey) {
            await checkLivePeriodStatus(userAssigned, activePeriod.label);
        }

        if (liveSubmittedStatus) {
            DOM.states.submittedLock?.classList.remove('d-none');
            DOM.footerDock?.classList.add('d-none');
            DOM.countersContainer?.classList.add('d-none');

            const waContainer = document.getElementById('whatsapp-share-container');
            const waBtn = document.getElementById('wa-share-btn');

            if (waContainer && waBtn) {
                waBtn.href = generateWhatsAppUrl(subjectTitle, activePeriod.label, customRollNumbers, studentStatus, liveSavedRecord?.presentRolls);
                waContainer.classList.remove('d-none');
            }

            if (DOM.dynamicTitle) DOM.dynamicTitle.innerHTML = `${subjectTitle} <span class="text-success">&lt; Completed &gt;</span>`;
            if (DOM.liveTime) DOM.liveTime.innerText = `${currentDay}, ${hrs}:${mins} • Submission Received`;
            return;
        }

        DOM.states.active?.classList.remove('d-none');
        DOM.footerDock?.classList.remove('d-none');
        DOM.countersContainer?.classList.remove('d-none');

        const totalSecsRemaining = (activePeriod.endMins * 60) - (currentMins * 60 + parseInt(secs, 10));
        const minsLeft = String(Math.floor(totalSecsRemaining / 60)).padStart(2, '0');
        const secsLeft = String(totalSecsRemaining % 60).padStart(2, '0');

        if (DOM.dynamicTitle) DOM.dynamicTitle.innerHTML = `${subjectTitle} <span class="text-primary">&lt; ${activePeriod.label} &gt;</span>`;
        if (DOM.liveTime) DOM.liveTime.innerHTML = `${currentDay}, ${hrs}:${mins} • <strong class="text-success">${activePeriod.label} (${minsLeft}:${secsLeft})</strong>`;
        return;
    }

    DOM.states.noClass?.classList.remove('d-none');
    DOM.footerDock?.classList.add('d-none');
    DOM.countersContainer?.classList.add('d-none');
    if (DOM.dynamicTitle) DOM.dynamicTitle.innerText = subjectTitle;
    if (DOM.liveTime) DOM.liveTime.innerText = `${currentDay}, ${hrs}:${mins}`;
}

function checkScheduleAllocation(userAssignedSubject, currentDay, activePeriodNumber) {
    if (!Array.isArray(dbData.schedule)) return false;
    return dbData.schedule.some(s => {
        const sCode = String(s.SubjectCode || s.subjectcode || '').trim().toLowerCase();
        const sDay = String(s.Day || s.day || '').trim().toLowerCase();
        const sPeriod = String(s.Period || s.period || '').replace(/\D/g, '');
        return sCode === String(userAssignedSubject).trim().toLowerCase() && sDay === String(currentDay).trim().toLowerCase() && sPeriod === String(activePeriodNumber);
    });
}

function loadRolls(subjectCode, periodLabel) {
    const subj = dbData.subjects.find(s => String(s.SubjectCode || s.subjectcode || '').trim().toLowerCase() === String(subjectCode).trim().toLowerCase());
    if (subj) {
        customRollNumbers = (subj.RollList || subj.rolllist || '').split(',').map(r => r.trim()).filter(Boolean);
        studentStatus = Array(customRollNumbers.length).fill(false);
        loadDraft(subjectCode, periodLabel);
        renderAttendanceGrid();
    }
}

function renderAttendanceGrid() {
    if (!DOM.attendanceGrid) return;

    DOM.attendanceGrid.innerHTML = customRollNumbers.map((roll, idx) => `
        <div class="col">
            <div onclick="toggleStudent(${idx})" class="student-card p-2 rounded-3 text-center border cursor-pointer ${studentStatus[idx] ? 'is-present' : ''}">
                <div class="extra-small fw-bold opacity-75">ROLL</div>
                <div class="h5 fw-bold my-1">${roll}</div>
                <span class="badge ${studentStatus[idx] ? 'bg-white text-success' : 'bg-light text-secondary'}" style="font-size: 8px;">
                    ${studentStatus[idx] ? 'PRESENT' : 'ABSENT'}
                </span>
            </div>
        </div>
    `).join('');

    const presentCount = studentStatus.filter(Boolean).length;
    if (DOM.presentCount) DOM.presentCount.innerText = presentCount;
    if (DOM.absentCount) DOM.absentCount.innerText = customRollNumbers.length - presentCount;
    if (DOM.submitBtn) DOM.submitBtn.disabled = presentCount === 0;
}

function toggleStudent(i) {
    studentStatus[i] = !studentStatus[i];
    const now = getAccurateDate();
    const currentMins = now.getHours() * 60 + now.getMinutes();
    const activePeriodObj = PERIOD_TIMES.find(p => currentMins >= p.startMins && currentMins < p.endMins);
    if (activePeriodObj && currentActiveSubject) saveDraft(currentActiveSubject, activePeriodObj.label);
    renderAttendanceGrid();
}

async function submitAttendance() {
    if (!currentUser || !currentActiveSubject) {
        alert("Session invalid or no active subject found.");
        return;
    }

    const now = getAccurateDate();
    const currentMins = now.getHours() * 60 + now.getMinutes();
    const activePeriodObj = PERIOD_TIMES.find(p => currentMins >= p.startMins && currentMins < p.endMins);
    const activePeriodLabel = activePeriodObj ? activePeriodObj.label : "Manual Sync";

    DOM.submitBtn.disabled = true;
    const originalText = DOM.submitBtn.innerText;
    DOM.submitBtn.innerText = "Syncing...";

    const records = customRollNumbers.map((roll, idx) => ({
        rollNo: String(roll).trim(),
        status: studentStatus[idx] ? "Present" : "0"
    }));

    const payload = JSON.stringify({
        action: "saveAttendance",
        subjectCode: currentActiveSubject,
        period: activePeriodLabel,
        records
    });

    const subjObj = dbData.subjects.find(s => String(s.SubjectCode || s.subjectcode || '').trim().toLowerCase() === String(currentActiveSubject).trim().toLowerCase());
    const subjectTitle = subjObj ? (subjObj.SubjectName || subjObj.subjectname || currentActiveSubject) : currentActiveSubject;
    const waUrl = generateWhatsAppUrl(subjectTitle, activePeriodLabel, customRollNumbers, studentStatus);

    try {
        await fetch(SCRIPT_URL, {
            method: "POST",
            mode: "no-cors",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: "postData=" + encodeURIComponent(payload)
        });

        setPeriodSubmittedLock(currentActiveSubject, activePeriodLabel, waUrl);
        clearDraft(currentActiveSubject, activePeriodLabel);

        liveSubmittedStatus = true;
        liveSavedRecord = { presentRolls: customRollNumbers.filter((_, idx) => studentStatus[idx]) };

        alert(`✅ Attendance saved successfully!`);
        if (waUrl) window.open(waUrl, '_blank');
        updateClock();

    } catch (err) {
        console.error("Submission Error:", err);
        alert("⚠️ Connection Error: Data could not reach Google Sheets.");
    } finally {
        DOM.submitBtn.disabled = false;
        DOM.submitBtn.innerText = originalText;
    }
}

document.getElementById('mark-all-btn')?.addEventListener('click', () => { 
    studentStatus.fill(true); 
    renderAttendanceGrid(); 
});

document.getElementById('clear-all-btn')?.addEventListener('click', () => { 
    studentStatus.fill(false); 
    renderAttendanceGrid(); 
});
