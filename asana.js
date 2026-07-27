// REV77 — Asana Integration
const https = require('https');

// ── Core HTTP helper — follows redirects across hosts ─────────────────────────
function asanaRequest(hostname, path, redirectCount = 0) {
  const ASANA_TOKEN = process.env.ASANA_TOKEN;
  if (!ASANA_TOKEN) return Promise.reject(new Error('ASANA_TOKEN not set'));
  if (redirectCount > 5) return Promise.reject(new Error('Too many redirects'));

  return new Promise((resolve, reject) => {
    const options = {
      hostname,
      path,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${ASANA_TOKEN}`,
        'Accept': 'application/json',
      },
    };

    const req = https.request(options, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        console.log(`Asana redirect [${res.statusCode}] → ${res.headers.location}`);
        try {
          const url = new URL(res.headers.location);
          res.resume();
          resolve(asanaRequest(url.hostname, url.pathname + url.search, redirectCount + 1));
        } catch (e) {
          reject(new Error(`Bad redirect URL: ${res.headers.location}`));
        }
        return;
      }

      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        console.log(`Asana [${res.statusCode}] ${hostname}${path.substring(0,60)} — ${data.length} bytes`);
        if (!data) { reject(new Error(`Empty response (HTTP ${res.statusCode})`)); return; }
        try {
          const parsed = JSON.parse(data);
          if (parsed.errors) reject(new Error(parsed.errors[0].message));
          else resolve(parsed);  // return full response including next_page
        } catch (e) {
          reject(new Error(`JSON parse failed: ${e.message}`));
        }
      });
    });

    req.on('error', reject);
    req.end();
  });
}

function asanaGet(path) {
  return asanaRequest('api.asana.com', `/api/1.0${path}`).then(r => r.data);
}

// ── Get ALL projects with pagination ──────────────────────────────────────────
async function getAllProjects(wGid) {
  let allProjects = [];
  let offset      = null;

  do {
    const offsetParam = offset ? `&offset=${offset}` : '';
    const response    = await asanaRequest(
      'api.asana.com',
      `/api/1.0/projects?workspace=${wGid}&archived=false&limit=100&opt_fields=name,gid${offsetParam}`
    );
    // Follow redirect wrapper — response.data has projects, response.next_page has cursor
    const body = response;
    allProjects = allProjects.concat(body.data || []);
    offset = body.next_page ? body.next_page.offset : null;
    console.log(`Fetched ${allProjects.length} projects so far...`);
  } while (offset);

  return allProjects;
}

// ── API helpers ───────────────────────────────────────────────────────────────
async function getWorkspaces()         { return await asanaGet('/workspaces'); }
async function getProjects(wGid)       { return await getAllProjects(wGid); }
async function getSections(pGid)       { return await asanaGet(`/projects/${pGid}/sections`); }
async function getTasksInSection(sGid) { return await asanaGet(`/sections/${sGid}/tasks?opt_fields=name,completed,due_on,assignee,notes,completed_at,created_at&limit=100`); }
async function getTasksInProject(pGid) { return await asanaGet(`/projects/${pGid}/tasks?opt_fields=name,completed,due_on,assignee,notes,completed_at,created_at&limit=100`); }

async function findProject(wGid, name) {
  const projects = await getProjects(wGid);
  return projects.find(p => p.name.toLowerCase().trim().includes(name.toLowerCase().trim())) || null;
}

function parseClientFromTask(taskName) {
  const parts = taskName.split(' - ');
  return parts.length >= 2 ? parts[0].trim() : null;
}

// ── Score delivery ────────────────────────────────────────────────────────────
function scoreDelivery(tasks, scoringDate = new Date()) {
  if (!tasks || tasks.length === 0) {
    return { score: null, totalTasks: 0, completedOnTime: 0, completedLate: [], overdueTasks: [], upcomingTasks: [], flags: [], summary: 'No tasks found' };
  }

  const today = new Date(scoringDate);
  today.setHours(0, 0, 0, 0);

  const overdueTasks = [], completedOnTime = [], completedLate = [], upcomingTasks = [], flags = [];

  for (const task of tasks) {
    const dueDate    = task.due_on ? new Date(task.due_on) : null;
    const isPriority = task.name?.toLowerCase().includes('priority');

    if (task.completed) {
      const completedAt = task.completed_at ? new Date(task.completed_at) : null;
      if (dueDate && completedAt && completedAt > dueDate) completedLate.push({ ...task, isPriority });
      else completedOnTime.push({ ...task, isPriority });
    } else {
      if (dueDate && dueDate < today) {
        const daysOverdue = Math.floor((today - dueDate) / (1000 * 60 * 60 * 24));
        overdueTasks.push({ ...task, isPriority, daysOverdue });
        flags.push(`${isPriority ? 'Priority task' : 'Task'} overdue: "${task.name}" (${task.due_on})`);
      } else if (dueDate) {
        upcomingTasks.push({ ...task, isPriority });
      }
    }
  }

  let score = 100;
  score -= Math.min(overdueTasks.length * 15, 60);
  score -= Math.min(overdueTasks.filter(t => t.isPriority).length * 10, 20);
  score -= Math.min(completedLate.length * 5, 20);

  const dueTasks       = tasks.filter(t => t.due_on && new Date(t.due_on) <= today);
  const onTimeCount    = completedOnTime.filter(t => t.due_on && new Date(t.due_on) <= today).length;
  const completionRate = dueTasks.length > 0 ? onTimeCount / dueTasks.length : 1;
  if (completionRate === 1 && dueTasks.length > 0) score = Math.min(score + 5, 100);
  score = Math.max(0, Math.round(score));

  const parts = [];
  if (overdueTasks.length)    parts.push(`${overdueTasks.length} overdue`);
  if (completedLate.length)   parts.push(`${completedLate.length} completed late`);
  if (completedOnTime.length) parts.push(`${completedOnTime.length} on time`);
  if (upcomingTasks.length)   parts.push(`${upcomingTasks.length} upcoming`);

  return {
    score,
    totalTasks:      tasks.length,
    completedOnTime: completedOnTime.length,
    completedLate:   completedLate.length,
    overdueTasks,
    upcomingTasks,
    flags,
    completionRate:  Math.round(completionRate * 100),
    summary:         parts.join(' | ') || 'No due tasks',
  };
}

// ── Get delivery score by explicit project name ───────────────────────────────
async function getClientDeliveryScoreByProject(wGid, projectName) {
  try {
    const project = await findProject(wGid, projectName);
    if (!project) return { score: null, error: `Project not found: "${projectName}"`, tasks: [], source: null };
    const tasks = await getTasksInProject(project.gid);
    return { ...scoreDelivery(tasks), source: project.name, projectName: project.name, projectGid: project.gid };
  } catch (err) {
    console.error('getClientDeliveryScoreByProject error:', err.message);
    return { score: null, error: err.message, tasks: [] };
  }
}

// ── Get delivery score for one client ─────────────────────────────────────────
async function getClientDeliveryScore(wGid, clientName) {
  try {
    // 1. Try DailyStandUp section
    const dailyStandUp = await findProject(wGid, 'DailyStandUp');
    if (dailyStandUp) {
      const sections      = await getSections(dailyStandUp.gid);
      const clientSection = sections.find(s =>
        s.name.toLowerCase().includes(clientName.toLowerCase()) ||
        clientName.toLowerCase().includes(s.name.toLowerCase())
      );
      if (clientSection) {
        const tasks = await getTasksInSection(clientSection.gid);
        return { ...scoreDelivery(tasks), source: 'DailyStandUp', clientSection: clientSection.name };
      }
    }

    // 2. Fallback: standalone project
    console.log(`No section found for "${clientName}" — searching standalone projects...`);
    const allProjects    = await getProjects(wGid);
    const matchedProject = allProjects.find(p =>
      p.name.toLowerCase().trim().includes(clientName.toLowerCase().trim()) ||
      clientName.toLowerCase().trim().includes(p.name.toLowerCase().trim())
    );
    if (matchedProject) {
      const tasks = await getTasksInProject(matchedProject.gid);
      return { ...scoreDelivery(tasks), source: 'Standalone Project', projectName: matchedProject.name };
    }

    return { score: null, error: `No Asana section or project found for: "${clientName}"`, tasks: [], source: null };
  } catch (err) {
    console.error('getClientDeliveryScore error:', err.message);
    return { score: null, error: err.message, tasks: [] };
  }
}

// ── All clients from DailyStandUp ─────────────────────────────────────────────
async function getAllClientsDelivery(wGid) {
  const dailyStandUp = await findProject(wGid, 'DailyStandUp');
  if (!dailyStandUp) throw new Error('DailyStandUp project not found');

  const sections = await getSections(dailyStandUp.gid);
  const results  = {};
  for (const section of sections) {
    if (section.name === '(no section)') continue;
    const tasks = await getTasksInSection(section.gid);
    results[section.name] = { sectionGid: section.gid, ...scoreDelivery(tasks) };
  }
  return results;
}

// ── Test Project 5.2 ──────────────────────────────────────────────────────────
async function getTestProjectTasks(wGid) {
  const testProject = await findProject(wGid, 'Test Project 5.2');
  if (!testProject) throw new Error('Test Project 5.2 not found — may be beyond 100 project limit or in a team folder');

  const tasks  = await getTasksInProject(testProject.gid);
  const scored = scoreDelivery(tasks);

  return {
    projectName: testProject.name,
    projectGid:  testProject.gid,
    tasks: tasks.map(t => ({
      name:         t.name,
      due_on:       t.due_on,
      completed:    t.completed,
      completed_at: t.completed_at,
      isPriority:   t.name?.toLowerCase().includes('priority'),
      status: t.completed ? 'Completed'
            : (t.due_on && new Date(t.due_on) < new Date()) ? 'Overdue'
            : 'Upcoming',
    })),
    ...scored,
  };
}

module.exports = {
  getWorkspaces, getProjects, getAllProjects, getSections,
  getTasksInSection, getTasksInProject, findProject,
  scoreDelivery, getClientDeliveryScore, getClientDeliveryScoreByProject,
  getAllClientsDelivery, getTestProjectTasks,
  parseClientFromTask,
};
