// REV77 — Asana Integration
// Connects to Asana API, pulls tasks per client, calculates Delivery score

const https = require('https');

const ASANA_BASE  = 'api.asana.com';
const ASANA_TOKEN = process.env.ASANA_TOKEN;

// ── Core HTTP helper ──────────────────────────────────────────────────────────
function asanaGet(path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: ASANA_BASE,
      path: `/api/1.0${path}`,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${ASANA_TOKEN}`,
        'Accept': 'application/json',
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.errors) reject(new Error(parsed.errors[0].message));
          else resolve(parsed.data);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ── API helpers ───────────────────────────────────────────────────────────────
async function getWorkspaces()          { return await asanaGet('/workspaces'); }
async function getProjects(wGid)        { return await asanaGet(`/projects?workspace=${wGid}&archived=false&limit=100`); }
async function getSections(pGid)        { return await asanaGet(`/projects/${pGid}/sections`); }
async function getTasksInSection(sGid)  { return await asanaGet(`/sections/${sGid}/tasks?opt_fields=name,completed,due_on,assignee,notes,completed_at,created_at&limit=100`); }
async function getTasksInProject(pGid)  { return await asanaGet(`/projects/${pGid}/tasks?opt_fields=name,completed,due_on,assignee,notes,completed_at,created_at,memberships.section.name&limit=100`); }

// ── Find project by name (partial match) ──────────────────────────────────────
async function findProject(wGid, name) {
  const projects = await getProjects(wGid);
  return projects.find(p => p.name.toLowerCase().includes(name.toLowerCase())) || null;
}

// ── Parse client name from task name ─────────────────────────────────────────
// Convention: "Client Name - task description"
function parseClientFromTask(taskName) {
  const parts = taskName.split(' - ');
  return parts.length >= 2 ? parts[0].trim() : null;
}

// ── Score a set of tasks ──────────────────────────────────────────────────────
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

  const dueTasks = tasks.filter(t => t.due_on && new Date(t.due_on) <= today);
  const onTimeCount = completedOnTime.filter(t => t.due_on && new Date(t.due_on) <= today).length;
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

// ── Get delivery score for a single client ────────────────────────────────────
// Lookup order:
//   1. Section inside Daily Stand Up matching client name
//   2. Standalone project matching client name (fallback for test/demo clients)
async function getClientDeliveryScore(wGid, clientName) {
  try {
    // ── Step 1: Try Daily Stand Up section ─────────────────────────────────
    const dailyStandUp = await findProject(wGid, 'Daily Stand Up');

    if (dailyStandUp) {
      const sections = await getSections(dailyStandUp.gid);
      const clientSection = sections.find(s =>
        s.name.toLowerCase().includes(clientName.toLowerCase()) ||
        clientName.toLowerCase().includes(s.name.toLowerCase())
      );

      if (clientSection) {
        const tasks = await getTasksInSection(clientSection.gid);
        return {
          ...scoreDelivery(tasks),
          source:        'Daily Stand Up',
          clientSection: clientSection.name,
          sectionGid:    clientSection.gid,
        };
      }
    }

    // ── Step 2: Fallback — look for a standalone project matching client name
    console.log(`No section found for "${clientName}" in Daily Stand Up — searching standalone projects...`);
    const allProjects = await getProjects(wGid);
    const matchedProject = allProjects.find(p =>
      p.name.toLowerCase().includes(clientName.toLowerCase()) ||
      clientName.toLowerCase().includes(p.name.toLowerCase())
    );

    if (matchedProject) {
      const tasks = await getTasksInProject(matchedProject.gid);
      return {
        ...scoreDelivery(tasks),
        source:      'Standalone Project',
        projectName: matchedProject.name,
        projectGid:  matchedProject.gid,
      };
    }

    // ── Nothing found ───────────────────────────────────────────────────────
    return {
      score:  null,
      error:  `No Asana section or project found for client: "${clientName}"`,
      tasks:  [],
      source: null,
    };

  } catch (err) {
    console.error('Asana error:', err.message);
    return { score: null, error: err.message, tasks: [] };
  }
}

// ── Get delivery scores for ALL clients from Daily Stand Up ───────────────────
async function getAllClientsDelivery(wGid) {
  try {
    const dailyStandUp = await findProject(wGid, 'Daily Stand Up');
    if (!dailyStandUp) throw new Error('Daily Stand Up project not found');

    const sections = await getSections(dailyStandUp.gid);
    const results  = {};

    for (const section of sections) {
      if (section.name === '(no section)') continue;
      const tasks = await getTasksInSection(section.gid);
      results[section.name] = { sectionGid: section.gid, ...scoreDelivery(tasks) };
    }

    return results;
  } catch (err) {
    console.error('Asana error:', err.message);
    throw err;
  }
}

// ── Test endpoint: pull Test Project 5.2 directly ────────────────────────────
async function getTestProjectTasks(wGid) {
  try {
    const testProject = await findProject(wGid, 'Test Project 5.2');
    if (!testProject) throw new Error('Test Project 5.2 not found');

    const tasks  = await getTasksInProject(testProject.gid);
    const scored = scoreDelivery(tasks);

    return {
      projectName: testProject.name,
      projectGid:  testProject.gid,
      tasks: tasks.map(t => ({
        name:        t.name,
        due_on:      t.due_on,
        completed:   t.completed,
        completed_at:t.completed_at,
        isPriority:  t.name?.toLowerCase().includes('priority'),
        status: t.completed ? 'Completed'
              : (t.due_on && new Date(t.due_on) < new Date()) ? 'Overdue'
              : 'Upcoming',
      })),
      ...scored,
    };
  } catch (err) {
    console.error('Asana test error:', err.message);
    throw err;
  }
}

module.exports = {
  getWorkspaces, getProjects, getSections,
  getTasksInSection, getTasksInProject, findProject,
  scoreDelivery, getClientDeliveryScore,
  getAllClientsDelivery, getTestProjectTasks,
  parseClientFromTask,
};
