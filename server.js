const express = require('express');
const { parties, boothSessions, voters, votes, staff, historyArchive, schedules, systemHistory } = require('./database');

const app = express();
app.use(express.json({ limit: '15mb' }));

// Disable automatic index.html serving so '/' routes directly to about.html
app.use(express.static('public', { index: false }));

// ==========================================
// 📌 ROUTE: Explicit Root Landing Page
// ==========================================
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/public/about.html');
});

let adminCredentials = { username: 'Ansh', password: 'Ansh8812' };

function getISTTimestamp() {
    return new Date().toLocaleString('en-IN', {
        timeZone: 'Asia/Kolkata',
        hour12: false,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    });
}

function normalizeBoothCode(code) {
    if (!code) return '';
    let clean = code.toString().trim().toUpperCase();
    if (!clean.startsWith('BOOTH-')) clean = 'BOOTH-' + clean;
    return clean;
}

async function logSystemEvent(eventType, description, initiatedBy = 'SYSTEM', locationContext = 'CENTRAL-SERVER') {
    const timestamp = getISTTimestamp();
    try {
        await systemHistory.insert({
            eventType,
            description,
            initiatedBy,
            locationContext,
            timestamp,
            createdAt: new Date()
        });
    } catch (e) {}

    console.log(`\n[TERMUX ACTIVITY LOG] 🕒 ${timestamp}`);
    console.log(` ├── ⚡ ACTION: ${eventType}`);
    console.log(` ├── 👤 WHO:    ${initiatedBy}`);
    console.log(` ├── 📍 WHERE:  ${locationContext}`);
    console.log(` └── 📝 WHY/WHAT: ${description}\n`);
}

function verifyAdminSession(req, res, next) {
    const userRole = req.headers['x-user-role'];
    const token = req.headers['x-admin-token'];
    
    if (userRole === 'admin' || (token && token.startsWith('ADM_SESS_'))) {
        return next();
    }
    res.status(401).json({ error: "UNAUTHORIZED", message: "Master Admin authentication required!" });
}

async function checkAndEnforceScheduleExpiry() {
    const now = new Date();
    const activeSchedules = await schedules.find({ status: 'ACTIVE' });

    for (let sched of activeSchedules) {
        const endTime = new Date(sched.endTime);
        if (now > endTime) {
            await schedules.update({ _id: sched._id }, { $set: { status: 'CLOSED' } });
            
            const sTarget = (sched.targetBooth || 'ALL').trim().toUpperCase();
            if (sTarget === 'ALL') {
                await boothSessions.update({ status: { $ne: 'CLOSED' } }, { $set: { status: 'CLOSED' } }, { multi: true });
            } else {
                const targetNorm = normalizeBoothCode(sTarget);
                await boothSessions.update({ booth_code: targetNorm, status: { $ne: 'CLOSED' } }, { $set: { status: 'CLOSED' } });
            }

            await logSystemEvent('SCHEDULE_AUTO_EXPIRED', `Schedule "${sched.title}" reached its end time and was automatically CLOSED.`, 'SYSTEM', 'GAZETTE-SCHEDULER');
        }
    }
}

async function validateBoothTiming(boothCode) {
    await checkAndEnforceScheduleExpiry();
    const targetNorm = normalizeBoothCode(boothCode);
    const booth = await boothSessions.findOne({ booth_code: targetNorm });
    
    if (!booth) return { allowed: false, error: "Invalid Booth Code!" };
    if (booth.status === 'PAUSED') return { allowed: false, error: "Polling is currently PAUSED by the officer." };
    if (booth.status === 'CLOSED') return { allowed: false, error: "This booth station is CLOSED." };
    if (booth.status === 'PENDING') return { allowed: false, error: "Booth is PENDING! Polling officer must activate it." };

    return { allowed: true };
}

// ================= API ENDPOINTS =================

app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body;
    if (username === adminCredentials.username && password === adminCredentials.password) {
        const token = 'ADM_SESS_ACTIVE_' + Date.now();
        await logSystemEvent('ADMIN_LOGIN', 'Master Admin logged in.', 'Ansh', 'ADMIN-PORTAL');
        return res.json({ success: true, role: 'admin', token, redirect: '/admin.html', username: adminCredentials.username });
    }

    try {
        const member = await staff.findOne({ username, password });
        if (member) {
            const portalMap = { 'manager': '/manager.html', 'polling_officer': '/polling.html', 'voter_manager': '/voters.html', 'party_head': '/parties.html' };
            await logSystemEvent('STAFF_LOGIN', `Staff member ${member.full_name} logged in.`, member.username, 'STAFF-PORTAL');
            return res.json({ success: true, role: member.role, redirect: portalMap[member.role] || '/admin-login.html', name: member.full_name, username: member.username });
        }
    } catch (err) {}
    res.status(401).json({ error: "Invalid Credentials!" });
});

app.post('/api/admin/change-credentials', verifyAdminSession, async (req, res) => {
    const { oldUsername, oldPassword, newUsername, newPassword } = req.body;
    if (oldUsername !== adminCredentials.username || oldPassword !== adminCredentials.password) {
        return res.status(401).json({ error: "Old Credentials do not match!" });
    }
    adminCredentials.username = newUsername;
    adminCredentials.password = newPassword;
    await logSystemEvent('SECURITY_CREDENTIALS_CHANGED', 'Admin username and password updated.', 'Master Admin', 'SETTINGS-PANEL');
    res.json({ success: true, message: "Admin Credentials Updated!" });
});

app.get('/api/admin/check-system-data', verifyAdminSession, async (req, res) => {
    await checkAndEnforceScheduleExpiry();
    const allBooths = await boothSessions.find({});
    const activeScheds = await schedules.find({ status: 'ACTIVE' });
    const totalVoters = (await voters.find({})).length;
    const totalVotes = (await votes.find({})).length;

    res.json({
        boothsSummary: allBooths.map(b => ({ code: b.booth_code, location: b.location, status: b.status })),
        activeSchedulesCount: activeScheds.length,
        totalRegisteredVoters: totalVoters,
        totalVotesCast: totalVotes,
        turnoutPercentage: totalVoters > 0 ? ((totalVotes / totalVoters) * 100).toFixed(1) + '%' : '0%',
        serverUptimeSeconds: Math.floor(process.uptime()),
        databaseStatus: 'CONNECTED_HEALTHY',
        checkedAt: getISTTimestamp()
    });
});

app.get('/api/admin/voters', async (req, res) => res.json(await voters.find({})));

app.post('/api/admin/add-voter-profile', verifyAdminSession, async (req, res) => {
    const { voterId, fullName, college, phone, assignedBooth } = req.body;
    const cleanId = (voterId || '').trim();
    if (cleanId.length !== 6 || isNaN(cleanId)) {
        return res.status(400).json({ error: "Voter ID must be exactly 6 numeric digits!" });
    }
    const existing = await voters.findOne({ voter_id: cleanId });
    if (existing) return res.status(400).json({ error: "Voter ID already registered!" });

    await voters.insert({ 
        voter_id: cleanId, 
        full_name: fullName.trim(), 
        college: college || 'N/A', 
        phone: phone || 'N/A', 
        assigned_booth: normalizeBoothCode(assignedBooth || 'UNASSIGNED'), 
        has_voted: false 
    });

    await logSystemEvent('VOTER_REGISTERED', `Registered voter ${fullName} (${cleanId}) assigned to booth ${assignedBooth || 'UNASSIGNED'}.`, 'Master Admin', 'VOTER-MANAGER');
    res.json({ success: true, message: "Voter Registered Successfully!" });
});

app.post('/api/admin/bulk-add-voters', verifyAdminSession, async (req, res) => {
    const { rawRows, defaultBooth } = req.body;
    if (!rawRows || !rawRows.trim()) return res.status(400).json({ error: "No data provided" });
    const lines = rawRows.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    let added = 0;
    for (let line of lines) {
        let parts = line.split('-').map(s => s.trim());
        let vId = parts[0];
        let remaining = parts.slice(1).join('-');
        let commaParts = remaining.split(',').map(s => s.trim());
        let vName = commaParts[0] || `Voter ${vId}`;
        let college = commaParts[1] || 'N/A';
        let phone = commaParts[2] || 'N/A';

        if (vId && vId.length === 6 && !isNaN(vId)) {
            const existing = await voters.findOne({ voter_id: vId });
            if (!existing) {
                await voters.insert({ 
                    voter_id: vId, 
                    full_name: vName, 
                    college, 
                    phone, 
                    assigned_booth: normalizeBoothCode(defaultBooth || 'UNASSIGNED'), 
                    has_voted: false 
                });
                added++;
            }
        }
    }

    await logSystemEvent('BULK_VOTERS_IMPORTED', `Successfully imported ${added} voters in bulk into booth ${defaultBooth || 'UNASSIGNED'}.`, 'Master Admin', 'BULK-IMPORT');
    res.json({ success: true, message: `Imported ${added} valid voters!` });
});

app.post('/api/admin/edit-voter-profile', verifyAdminSession, async (req, res) => {
    const { id, voterId, fullName, college, phone, assignedBooth } = req.body;
    await voters.update({ _id: id }, { $set: { voter_id: voterId.trim(), full_name: fullName.trim(), college, phone, assigned_booth: normalizeBoothCode(assignedBooth) } });
    await logSystemEvent('VOTER_UPDATED', `Voter profile ${voterId} (${fullName}) updated.`, 'Master Admin', 'VOTER-MANAGER');
    res.json({ success: true });
});

app.post('/api/admin/delete-voter', verifyAdminSession, async (req, res) => {
    const target = await voters.findOne({ _id: req.body.id });
    await voters.remove({ _id: req.body.id }, {});
    await logSystemEvent('VOTER_DELETED', `Voter profile ${target ? target.voter_id : ''} deleted.`, 'Master Admin', 'VOTER-MANAGER');
    res.json({ success: true });
});

app.post('/api/admin/clear-all-voters', verifyAdminSession, async (req, res) => {
    await voters.remove({}, { multi: true });
    await logSystemEvent('REGISTRY_PURGED', 'Entire voter registry cleared.', 'Master Admin', 'VOTER-MANAGER');
    res.json({ success: true });
});

app.post('/api/admin/reset-voter-status', verifyAdminSession, async (req, res) => {
    const { voterId } = req.body;
    const cleanId = (voterId || '').trim();
    
    const voter = await voters.findOne({ voter_id: cleanId });
    if (!voter) return res.status(404).json({ error: "Voter ID not found in database!" });

    await voters.update({ voter_id: cleanId }, { $set: { has_voted: false } });
    await votes.remove({ voter_id: cleanId }, { multi: true });

    await logSystemEvent('VOTER_STATUS_RESET', `Voter ID ${cleanId} reset from VOTED to UNVOTED.`, 'Master Admin', 'STATUS-MANAGER');
    res.json({ success: true, message: `Voter ID ${cleanId} status reset to UNVOTED!` });
});

app.post('/api/admin/bulk-reset-voters', verifyAdminSession, async (req, res) => {
    const { rawRows } = req.body;
    if (!rawRows || !rawRows.trim()) return res.status(400).json({ error: "No Voter IDs provided" });

    const lines = rawRows.split(/[\n,]+/).map(l => l.trim()).filter(l => l.length > 0);
    let resetCount = 0;

    for (let idToken of lines) {
        let cleanId = idToken.split('-')[0].trim();
        if (cleanId.length === 6 && !isNaN(cleanId)) {
            const voter = await voters.findOne({ voter_id: cleanId });
            if (voter && voter.has_voted) {
                await voters.update({ voter_id: cleanId }, { $set: { has_voted: false } });
                await votes.remove({ voter_id: cleanId }, { multi: true });
                resetCount++;
            }
        }
    }

    await logSystemEvent('BULK_VOTERS_RESET', `Row-wise reset executed. ${resetCount} voters shifted from VOTED to UNVOTED.`, 'Master Admin', 'STATUS-MANAGER');
    res.json({ success: true, message: `Successfully shifted ${resetCount} voters back to UNVOTED status!` });
});

app.post('/api/admin/reset-leaderboard-votes', verifyAdminSession, async (req, res) => {
    const allVotes = await votes.find({});
    if (allVotes.length > 0) {
        await historyArchive.insert({
            archivedAt: getISTTimestamp(),
            totalVotesArchived: allVotes.length,
            votesSnapshot: allVotes
        });
    }

    await votes.remove({}, { multi: true });
    await voters.update({}, { $set: { has_voted: false } }, { multi: true });

    await logSystemEvent('LEADERBOARD_RESET', 'Leaderboard votes reset and archived into vault snapshot.', 'Master Admin', 'LEADERBOARD');
    res.json({ success: true, message: "Leaderboard votes reset and snapshot saved to History Archive!" });
});

app.get('/api/admin/history/archives', verifyAdminSession, async (req, res) => {
    const archives = await historyArchive.find({});
    res.json(archives.sort((a, b) => new Date(b.archivedAt) - new Date(a.archivedAt)));
});

app.get('/api/parties', async (req, res) => res.json(await parties.find({})));

app.post('/api/admin/add-party', verifyAdminSession, async (req, res) => {
    const { partyName, leaderName } = req.body;
    const existing = await parties.findOne({ party_name: partyName.trim() });
    if (existing) return res.status(400).json({ error: "Party Name already exists!" });

    await parties.insert({ party_name: partyName.trim(), leader_name: leaderName || 'N/A', candidates: [] });
    await logSystemEvent('PARTY_CREATED', `Political party "${partyName.trim()}" created with leader ${leaderName || 'N/A'}.`, 'Master Admin', 'PARTY-SETUP');
    res.json({ success: true, message: "Party Created Successfully!" });
});

app.post('/api/admin/edit-party', verifyAdminSession, async (req, res) => {
    const { id, partyName, leaderName } = req.body;
    await parties.update({ _id: id }, { $set: { party_name: partyName.trim(), leader_name: leaderName.trim() } });
    await logSystemEvent('PARTY_UPDATED', `Party details updated for ${partyName.trim()}.`, 'Master Admin', 'PARTY-SETUP');
    res.json({ success: true });
});

app.post('/api/admin/add-candidate', verifyAdminSession, async (req, res) => {
    const { partyName, candidateName, assignedBooth } = req.body;
    const party = await parties.findOne({ party_name: partyName.trim() });
    if (!party) return res.status(404).json({ error: "Party not found!" });

    const newCandidate = {
        candId: 'CAND_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
        candidateName: candidateName.trim(),
        assignedBooth: normalizeBoothCode(assignedBooth || 'ALL')
    };

    const updatedCandidates = [...(party.candidates || []), newCandidate];
    await parties.update({ _id: party._id }, { $set: { candidates: updatedCandidates } });
    await logSystemEvent('CANDIDATE_ASSIGNED', `Candidate ${candidateName.trim()} added to party ${partyName.trim()} at booth ${assignedBooth || 'ALL'}.`, 'Master Admin', 'CANDIDATE-SETUP');
    res.json({ success: true, message: "Candidate Assigned to Party!" });
});

app.post('/api/admin/edit-candidate', verifyAdminSession, async (req, res) => {
    const { partyName, candId, candidateName, assignedBooth } = req.body;
    const party = await parties.findOne({ party_name: partyName.trim() });
    if (!party) return res.status(404).json({ error: "Party not found!" });

    const updatedCandidates = (party.candidates || []).map(c => {
        if (c.candId === candId) {
            return { candId, candidateName: candidateName.trim(), assignedBooth: normalizeBoothCode(assignedBooth || 'ALL') };
        }
        return c;
    });

    await parties.update({ _id: party._id }, { $set: { candidates: updatedCandidates } });
    await logSystemEvent('CANDIDATE_UPDATED', `Candidate ${candidateName.trim()} updated in party ${partyName.trim()}.`, 'Master Admin', 'CANDIDATE-SETUP');
    res.json({ success: true, message: "Candidate Details Updated!" });
});

app.post('/api/admin/delete-candidate', verifyAdminSession, async (req, res) => {
    const { partyName, candId } = req.body;
    const party = await parties.findOne({ party_name: partyName.trim() });
    if (!party) return res.status(404).json({ error: "Party not found!" });

    const updatedCandidates = (party.candidates || []).filter(c => c.candId !== candId);
    await parties.update({ _id: party._id }, { $set: { candidates: updatedCandidates } });
    await logSystemEvent('CANDIDATE_DELETED', `Candidate removed from party ${partyName.trim()}.`, 'Master Admin', 'CANDIDATE-SETUP');
    res.json({ success: true });
});

app.post('/api/admin/delete-party', verifyAdminSession, async (req, res) => {
    await parties.remove({ _id: req.body.id }, {});
    await logSystemEvent('PARTY_DELETED', 'Political party deleted from registry.', 'Master Admin', 'PARTY-SETUP');
    res.json({ success: true });
});

app.get('/api/admin/booths', async (req, res) => {
    await checkAndEnforceScheduleExpiry();
    res.json(await boothSessions.find({}));
});

app.get('/api/booth/check-status/:boothCode', async (req, res) => {
    const targetNorm = normalizeBoothCode(req.params.boothCode);
    const result = await validateBoothTiming(targetNorm);
    const booth = await boothSessions.findOne({ booth_code: targetNorm });
    res.json({ allowed: result.allowed, error: result.error, status: booth ? booth.status : 'CLOSED' });
});

app.get('/api/booth/active-schedule/:boothCode', async (req, res) => {
    await checkAndEnforceScheduleExpiry();
    const targetNorm = normalizeBoothCode(req.params.boothCode);
    const allSchedules = await schedules.find({ status: 'ACTIVE' });
    const matched = allSchedules.find(s => s.targetBooth === 'ALL' || normalizeBoothCode(s.targetBooth) === targetNorm);
    
    if (matched) {
        res.json({ active: true, title: matched.title, startTime: matched.startTime, endTime: matched.endTime });
    } else {
        res.json({ active: false });
    }
});

app.post('/api/admin/create-booth', verifyAdminSession, async (req, res) => {
    let { boothCode, location, headName, startPassword, sessionPassword, endPassword } = req.body;
    const cleanCode = normalizeBoothCode(boothCode || Math.floor(1000 + Math.random() * 9000));

    const existing = await boothSessions.findOne({ booth_code: cleanCode });
    if (existing) {
        return res.status(400).json({ error: `Booth code ${cleanCode} has already been registered in history!` });
    }

    await boothSessions.insert({ 
        booth_code: cleanCode, 
        location: location || 'Room 125', 
        head_name: headName || 'Ansh', 
        start_password: startPassword || '123',
        session_password: sessionPassword || '123',
        end_password: endPassword || '123', 
        status: 'PENDING',
        start_password_used: false
    });
    
    await logSystemEvent('NEW_POOL_BOOTH_CREATED', `New polling booth station ${cleanCode} established at location "${location || 'Room 125'}" under officer ${headName || 'Ansh'}.`, 'Master Admin', `BOOTH-${cleanCode}`);
    res.json({ success: true, boothCode: cleanCode });
});

app.post('/api/booth/start', async (req, res) => {
    await checkAndEnforceScheduleExpiry();
    const { boothCode, password } = req.body;
    const targetNorm = normalizeBoothCode(boothCode);
    const booth = await boothSessions.findOne({ booth_code: targetNorm });

    if (!booth) return res.status(404).json({ error: "Booth not found!" });
    if (booth.status === 'CLOSED') return res.status(403).json({ error: "This booth is CLOSED!" });

    if (booth.status === 'ACTIVE' || booth.status === 'PAUSED') {
        if (booth.session_password === password || booth.start_password === password) {
            await logSystemEvent('BOOTH_REAUTHENTICATED', `Polling station ${targetNorm} re-authenticated.`, booth.head_name, `BOOTH-${targetNorm}`);
            return res.json({ success: true, message: `Re-authenticated for ${targetNorm}!` });
        }
        return res.status(401).json({ error: "Invalid Session Relogin Password!" });
    }

    if (booth.start_password_used || booth.start_password === 'INVALIDATED') {
        return res.status(403).json({ error: "Start password has already been INVALIDATED!" });
    }

    if (booth.start_password !== password) return res.status(401).json({ error: "Invalid Start Password!" });

    await boothSessions.update({ _id: booth._id }, { 
        $set: { 
            status: 'ACTIVE', 
            start_password: 'INVALIDATED', 
            start_password_used: true 
        } 
    });

    await logSystemEvent('BOOTH_ACTIVATED', `Polling station ${targetNorm} activated by officer ${booth.head_name}.`, booth.head_name, `BOOTH-${targetNorm}`);
    res.json({ success: true, message: `Booth ${targetNorm} activated!` });
});

app.post('/api/booth/pause', async (req, res) => {
    const { boothCode, password } = req.body;
    const targetNorm = normalizeBoothCode(boothCode);
    const booth = await boothSessions.findOne({ booth_code: targetNorm });

    if (!booth) return res.status(404).json({ error: "Booth not found!" });
    if (booth.status === 'CLOSED') return res.status(403).json({ error: "Booth is CLOSED!" });
    if (booth.session_password !== password && booth.end_password !== password) return res.status(401).json({ error: "Invalid password!" });

    await boothSessions.update({ _id: booth._id }, { $set: { status: 'PAUSED' } });
    await logSystemEvent('BOOTH_PAUSED', `Polling station ${targetNorm} paused by officer ${booth.head_name}.`, booth.head_name, `BOOTH-${targetNorm}`);
    res.json({ success: true });
});

app.post('/api/booth/resume', async (req, res) => {
    await checkAndEnforceScheduleExpiry();
    const { boothCode, password } = req.body;
    const targetNorm = normalizeBoothCode(boothCode);
    const booth = await boothSessions.findOne({ booth_code: targetNorm });

    if (!booth) return res.status(404).json({ error: "Booth not found!" });
    if (booth.status === 'CLOSED') return res.status(403).json({ error: "Booth is CLOSED!" });
    if (booth.session_password !== password && booth.end_password !== password) return res.status(401).json({ error: "Invalid password!" });

    await boothSessions.update({ _id: booth._id }, { $set: { status: 'ACTIVE' } });
    await logSystemEvent('BOOTH_RESUMED', `Polling station ${targetNorm} resumed by officer ${booth.head_name}.`, booth.head_name, `BOOTH-${targetNorm}`);
    res.json({ success: true });
});

app.post('/api/booth/close', async (req, res) => {
    const { boothCode, password } = req.body;
    const targetNorm = normalizeBoothCode(boothCode);
    const booth = await boothSessions.findOne({ booth_code: targetNorm });

    if (!booth) return res.status(404).json({ error: "Booth not found!" });
    if (booth.end_password !== password) return res.status(401).json({ error: "Invalid End Password!" });

    const allVoters = await voters.find({});
    const boothVoters = allVoters.filter(v => normalizeBoothCode(v.assigned_booth) === targetNorm);
    const allVotes = await votes.find({});
    const boothVotes = allVotes.filter(v => normalizeBoothCode(v.booth_code) === targetNorm);

    const voterCount = boothVotes.length;
    const leftCount = Math.max(0, boothVoters.length - voterCount);
    const notaCount = boothVotes.filter(v => v.party_id === 'NOTA').length;
    const nstCount = boothVotes.filter(v => v.party_id === 'NST').length;

    await boothSessions.update({ _id: booth._id }, { $set: { status: 'CLOSED', audit_voter_count: voterCount, audit_left_count: leftCount, audit_nota_count: notaCount, audit_nst_count: nstCount } });
    await logSystemEvent('BOOTH_PERMANENTLY_CLOSED', `Polling station ${targetNorm} permanently closed with audit: ${voterCount} voted, ${leftCount} left, ${notaCount} NOTA, ${nstCount} NST.`, booth.head_name, `BOOTH-${targetNorm}`);

    res.json({ success: true, audit: { boothCode: booth.booth_code, location: booth.location, headName: booth.head_name, voterCount, leftCount, notaCount, nstCount } });
});

app.post('/api/admin/override-booth-status', verifyAdminSession, async (req, res) => {
    const { boothCode, action } = req.body;
    const targetNorm = normalizeBoothCode(boothCode);
    const booth = await boothSessions.findOne({ booth_code: targetNorm });

    if (!booth && action !== 'HALT_ALL') return res.status(404).json({ error: "Booth not found!" });

    if (action === 'START') {
        await boothSessions.update({ _id: booth._id }, { $set: { status: 'ACTIVE' } });
        await logSystemEvent('ADMIN_OVERRIDE_START', `Admin force-started station ${targetNorm}.`, 'Master Admin', `BOOTH-${targetNorm}`);
    } else if (action === 'STOP') {
        await boothSessions.update({ _id: booth._id }, { $set: { status: 'PAUSED' } });
        await logSystemEvent('ADMIN_OVERRIDE_STOP', `Admin force-stopped station ${targetNorm}.`, 'Master Admin', `BOOTH-${targetNorm}`);
    } else if (action === 'HALT_ALL') {
        await boothSessions.update({}, { $set: { status: 'CLOSED' } }, { multi: true });
        await logSystemEvent('ADMIN_EMERGENCY_HALT', 'Emergency Election Halt triggered across all booth stations.', 'Master Admin', 'GLOBAL-HALT');
    }

    res.json({ success: true });
});

app.get('/api/admin/schedules/history', async (req, res) => {
    await checkAndEnforceScheduleExpiry();
    const list = await schedules.find({});
    const allVotes = await votes.find({}) || [];
    const allParties = await parties.find({}) || [];
    const totalVotersCount = (await voters.find({}) || []).length;

    const enriched = list.map(s => {
        const start = new Date(s.startTime);
        const end = new Date(s.endTime);
        const sTarget = (s.targetBooth || 'ALL').trim().toUpperCase();

        const matchingVotes = allVotes.filter(v => {
            if (!v.createdAt) return false;
            const vTime = new Date(v.createdAt);
            const timeMatch = (vTime >= start && vTime <= end);
            const vBoothNorm = normalizeBoothCode(v.booth_code);
            const boothMatch = (sTarget === 'ALL') || (normalizeBoothCode(sTarget) === vBoothNorm);
            return timeMatch && boothMatch;
        });

        const partyTallies = {};
        allParties.forEach(p => { partyTallies[p.party_name] = 0; });
        partyTallies['NOTA'] = 0;
        partyTallies['NST'] = 0;
        
        matchingVotes.forEach(v => {
            if (partyTallies[v.party_id] !== undefined) partyTallies[v.party_id]++;
            else partyTallies[v.party_id] = 1;
        });

        const totalVotesCast = matchingVotes.length;
        const turnout = totalVotersCount > 0 ? ((totalVotesCast / totalVotersCount) * 100).toFixed(1) : "0.0";

        return {
            ...s,
            totalVotesCast: totalVotesCast || 0,
            turnoutPercentage: parseFloat(turnout) || 0,
            partyTallies,
            timeTook: 'Active Window'
        };
    });

    res.json(enriched);
});

app.post('/api/admin/schedules/publish', verifyAdminSession, async (req, res) => {
    const { targetBooth, title, startTime, endTime } = req.body;
    const saved = await schedules.insert({ 
        targetBooth: targetBooth || 'ALL', 
        title: title || 'Schedule', 
        startTime, 
        endTime, 
        status: 'ACTIVE', 
        createdAt: getISTTimestamp() 
    });

    if (targetBooth === 'ALL') {
        await boothSessions.update({ status: { $ne: 'CLOSED' } }, { $set: { status: 'PENDING' } }, { multi: true });
    } else if (targetBooth) {
        const targetNorm = normalizeBoothCode(targetBooth);
        const booth = await boothSessions.findOne({ booth_code: targetNorm });
        if (booth && booth.status !== 'CLOSED') {
            await boothSessions.update({ _id: booth._id }, { $set: { status: 'PENDING' } });
        }
    }

    await logSystemEvent('SCHEDULE_PUBLISHED', `Polling schedule "${title}" published for scope ${targetBooth}.`, 'Master Admin', 'GAZETTE-SCHEDULER');
    res.json({ success: true, schedule: saved });
});

app.post('/api/admin/schedules/edit', verifyAdminSession, async (req, res) => {
    const { id, targetBooth, title, startTime, endTime } = req.body;
    await schedules.update({ _id: id }, { $set: { targetBooth, title, startTime, endTime, status: 'ACTIVE', updatedAt: getISTTimestamp() } });
    await logSystemEvent('SCHEDULE_UPDATED', `Schedule "${title}" revised.`, 'Master Admin', 'GAZETTE-SCHEDULER');
    res.json({ success: true, message: "Schedule Revised Successfully!" });
});

app.post('/api/admin/schedules/delete', verifyAdminSession, async (req, res) => {
    await schedules.remove({ _id: req.body.id }, {});
    await logSystemEvent('SCHEDULE_DELETED', 'Schedule gazette entry deleted.', 'Master Admin', 'GAZETTE-SCHEDULER');
    res.json({ success: true });
});

app.post('/api/vote/verify-voter', async (req, res) => {
    const { voterId, boothCode } = req.body;
    const cleanId = (voterId || '').trim();
    const targetBooth = normalizeBoothCode(boothCode);

    if (cleanId.length !== 6 || isNaN(cleanId)) {
        return res.status(400).json({ error: "Voter ID must be exactly 6 numeric digits!" });
    }

    const voter = await voters.findOne({ voter_id: cleanId });
    if (!voter) return res.status(404).json({ error: "Voter ID not registered in database!" });
    if (voter.has_voted) return res.status(400).json({ error: "Voter has ALREADY voted!" });

    if (voter.assigned_booth !== 'UNASSIGNED' && normalizeBoothCode(voter.assigned_booth) !== targetBooth) {
        return res.status(403).json({ error: `Assigned to ${voter.assigned_booth}. Cannot vote at ${targetBooth}!` });
    }

    res.json({ success: true, voter });
});

app.post('/api/vote', async (req, res) => {
    const { voterId, partyId, boothCode, voterPhoto } = req.body;
    const targetNorm = normalizeBoothCode(boothCode);
    const timeCheck = await validateBoothTiming(targetNorm);
    if (!timeCheck.allowed) return res.status(403).json({ error: timeCheck.error });

    const cleanId = (voterId || '').trim();
    const voter = await voters.findOne({ voter_id: cleanId });
    if (!voter) return res.status(400).json({ error: "Invalid Voter ID!" });
    if (voter.has_voted) return res.status(400).json({ error: "Already voted!" });

    const finalParty = partyId || 'NST';

    await votes.insert({ 
        voter_id: cleanId, 
        party_id: finalParty, 
        booth_code: targetNorm, 
        voter_photo: voterPhoto || '', 
        timestamp: getISTTimestamp(), 
        createdAt: new Date() 
    });
    await voters.update({ voter_id: cleanId }, { $set: { has_voted: true } });

    await logSystemEvent(
        'VOTE_CAST_SUCCESSFUL', 
        `Ballot successfully cast by Voter ${voter.full_name} (${cleanId}) for choice [${finalParty}].`, 
        voter.full_name, 
        targetNorm
    );

    res.json({ 
        success: true, 
        message: "Vote Cast Successfully!",
        voterDetails: {
            voterId: voter.voter_id,
            fullName: voter.full_name,
            phone: voter.phone,
            assignedBooth: targetNorm,
            voteStatus: "CONFIRMED & CAST"
        }
    });
});

app.get('/api/admin/history/voters', verifyAdminSession, async (req, res) => {
    const allVotes = await votes.find({});
    const allVoters = await voters.find({});

    res.json(allVoters.map(v => {
        const vRec = allVotes.find(x => x.voter_id === v.voter_id);
        return {
            voter_id: v.voter_id,
            full_name: v.full_name,
            college: v.college || 'N/A',
            phone: v.phone || 'N/A',
            assigned_booth: v.assigned_booth,
            voted_booth: vRec ? vRec.booth_code : 'Not Voted',
            timestamp: vRec ? vRec.timestamp : 'N/A',
            has_voted: v.has_voted,
            voter_photo: vRec ? vRec.voter_photo : null
        };
    }));
});

app.get('/api/admin/history/system', verifyAdminSession, async (req, res) => {
    const logs = await systemHistory.find({});
    res.json(logs.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)));
});

// PROTECTED PURGE ENDPOINT: PRESERVES ARCHIVES AND BOOTHS UNLESS EXPLICITLY OVERRIDDEN
app.post('/api/admin/clear-all-history', verifyAdminSession, async (req, res) => {
    await votes.remove({}, { multi: true });
    await systemHistory.remove({}, { multi: true });
    await voters.update({}, { $set: { has_voted: false } }, { multi: true });
    
    await logSystemEvent('PARTIAL_PURGE', 'Admin purged operational votes and system logs while preserving booths and permanent archive vaults.', 'Master Admin', 'PURGE-VAULT');
    res.json({ success: true, message: "Operational votes cleared. Booths and Archive Vaults protected!" });
});

app.get('/api/admin/audit-voter/:voterId', verifyAdminSession, async (req, res) => {
    const cleanId = req.params.voterId.trim();
    const voter = await voters.findOne({ voter_id: cleanId });
    if (!voter) return res.status(404).json({ error: "Voter ID not found in system database!" });
    const voteRecord = await votes.findOne({ voter_id: voter.voter_id });

    res.json({ 
        voter_id: voter.voter_id,
        full_name: voter.full_name,
        college: voter.college || 'N/A',
        phone: voter.phone || 'N/A',
        assigned_booth: voter.assigned_booth || 'UNASSIGNED',
        has_voted: voter.has_voted,
        vote_timestamp: voteRecord ? voteRecord.timestamp : 'Not Voted',
        voted_booth: voteRecord ? voteRecord.booth_code : 'N/A',
        voter_photo: voteRecord ? voteRecord.voter_photo : null,
        party_choice: voteRecord ? voteRecord.party_id : 'N/A'
    });
});

app.get('/api/admin/voted-voters-list', verifyAdminSession, async (req, res) => {
    const votedList = await voters.find({ has_voted: true });
    const allVotes = await votes.find({});
    res.json(votedList.map(v => {
        const vRecord = allVotes.find(x => x.voter_id === v.voter_id);
        return { 
            ...v, 
            voted_booth: vRecord ? vRecord.booth_code : v.assigned_booth, 
            timestamp: vRecord ? vRecord.timestamp : 'N/A',
            voter_photo: vRecord ? vRecord.voter_photo : null,
            party_choice: vRecord ? vRecord.party_id : 'N/A'
        };
    }));
});

app.get('/api/admin/analytics', async (req, res) => {
    const allVotes = await votes.find({}) || [];
    const allParties = await parties.find({}) || [];
    const allBooths = await boothSessions.find({}) || [];
    const totalVotes = allVotes.length;

    const partyCounts = {};
    allVotes.forEach(v => { const pId = (v.party_id || '').trim(); partyCounts[pId] = (partyCounts[pId] || 0) + 1; });

    const groupedParties = {};
    allParties.forEach(p => {
        if (!groupedParties[p.party_name]) groupedParties[p.party_name] = { party_name: p.party_name, leader_name: p.leader_name || 'N/A', candidates: [] };
        if (p.candidates) groupedParties[p.party_name].candidates.push(...p.candidates);
    });

    const leaderboard = Object.values(groupedParties).map(p => {
        const count = partyCounts[p.party_name] || 0;
        const percentage = totalVotes > 0 ? ((count / totalVotes) * 100).toFixed(1) : 0;
        return { party_name: p.party_name, leader_name: p.leader_name, totalCandidates: p.candidates.length, count, percentage: parseFloat(percentage) };
    }).sort((a, b) => b.count - a.count);

    const notaVotes = partyCounts['NOTA'] || 0;
    const nstVotes = partyCounts['NST'] || 0;
    
    leaderboard.push({ party_name: 'NOTA', leader_name: 'None of the Above', totalCandidates: 0, count: notaVotes, percentage: totalVotes > 0 ? parseFloat(((notaVotes / totalVotes) * 100).toFixed(1)) : 0 });
    leaderboard.push({ party_name: 'NST', leader_name: 'Not Submitted / Default', totalCandidates: 0, count: nstVotes, percentage: totalVotes > 0 ? parseFloat(((nstVotes / totalVotes) * 100).toFixed(1)) : 0 });

    const boothBreakdown = {};
    allBooths.forEach(b => {
        const bNorm = normalizeBoothCode(b.booth_code);
        boothBreakdown[b.booth_code] = { location: b.location, head_name: b.head_name, status: b.status, total: 0, candidateList: [] };
        const bVotes = allVotes.filter(v => normalizeBoothCode(v.booth_code) === bNorm);

        Object.values(groupedParties).forEach(p => {
            const pVotes = bVotes.filter(v => v.party_id === p.party_name).length;
            boothBreakdown[b.booth_code].candidateList.push({ candidate_name: p.party_name, party_name: p.party_name, votes: pVotes });
        });
        
        const bNota = bVotes.filter(v => v.party_id === 'NOTA').length;
        const bNst = bVotes.filter(v => v.party_id === 'NST').length;

        boothBreakdown[b.booth_code].candidateList.push({ candidate_name: 'NOTA', party_name: 'NOTA', votes: bNota });
        boothBreakdown[b.booth_code].candidateList.push({ candidate_name: 'NST', party_name: 'NST', votes: bNst });

        boothBreakdown[b.booth_code].total = bVotes.length;
        boothBreakdown[b.booth_code].nota = bNota;
        boothBreakdown[b.booth_code].nst = bNst;
    });

    res.json({ totalVotes: totalVotes || 0, leaderboard, boothBreakdown });
});

app.get('/api/admin/dashboard-stats', async (req, res) => {
    await checkAndEnforceScheduleExpiry();
    const totalVoters = (await voters.find({}) || []).length;
    const totalVotesCast = (await votes.find({}) || []).length;
    const activeBooths = (await boothSessions.find({ status: 'ACTIVE' }) || []).length;
    const totalBooths = (await boothSessions.find({}) || []).length;
    const turnout = totalVoters > 0 ? ((totalVotesCast / totalVoters) * 100).toFixed(1) : "0.0";
    const activeSched = (await schedules.find({ status: 'ACTIVE' }) || [])[0] || null;

    res.json({ totalVoters, totalVotesCast, activeBooths, totalBooths, turnout: parseFloat(turnout) || 0, schedule: activeSched });
});

async function printStartupDiagnostics() {
    console.log("==================================================");
    console.log(" 🔍 SYSTEM STARTUP DIAGNOSTICS REPORT");
    console.log("==================================================");
    try {
        const booths = await boothSessions.find({});
        const activeSchedules = await schedules.find({ status: 'ACTIVE' });
        const voterCount = (await voters.find({})).length;
        const voteCount = (await votes.find({})).length;
        const partyCount = (await parties.find({})).length;

        console.log(` • Database Connection (NeDB): [ OK ] Healthy`);
        console.log(` • Registered Voters:          [ ${voterCount} ] loaded`);
        console.log(` • Registered Parties:         [ ${partyCount} ] loaded`);
        console.log(` • Active Polling Booths:      [ ${booths.filter(b => b.status === 'ACTIVE').length} / ${booths.length} ] active`);
        console.log(` • Active Schedule Windows:    [ ${activeSchedules.length} ] running`);
        console.log(` • Total Votes Recorded:       [ ${voteCount} ] cast`);
        console.log("--------------------------------------------------");
        console.log(" 🏢 Registered Booth Status List:");
        if (booths.length === 0) {
            console.log("   (No polling booths created yet)");
        } else {
            booths.forEach(b => {
                console.log(`   - ${b.booth_code} (${b.location}): [ ${b.status || 'PENDING'} ]`);
            });
        }
    } catch (err) {
        console.log(" • Diagnostics Warning: Could not fetch complete metrics.");
    }
    console.log("==================================================");
}

// Bind dynamically to Render PORT
const PORT = process.env.PORT || 3000;

app.listen(PORT, '0.0.0.0', async () => {
    await printStartupDiagnostics();
    console.log(` Enterprise Election Server Running on Port ${PORT}!`);
    console.log(" Booths, Staff, and Archives Protected from Data Resets");
    console.log("==================================================");
});
