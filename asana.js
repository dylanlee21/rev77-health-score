// REV77 — Asana Integration
// Connects to Asana API, pulls tasks per client, calculates Delivery score

const https = require('https');

const ASANA_BASE = 'api.asana.com';
const ASANA_TOKEN = process.env.ASANA_TOKEN;

// ── Core HTTP helper ─────────────────────────────────────────────────────────
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
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ── Get all workspaces ────────────────────────────────────────────────────────
async function getWorkspaces() {
  return await asanaGet('/workspaces');
}

// ── Get all projects in a workspace ──────────────────────────────────────────
async function getProjects(workspaceGid) {
  return await asanaGet(`/projects?workspace=${workspaceGid}&archived=false&limit=100`);
}

// ── Get all sections in a project ────────────────────────────────────────────
async function getSections(projectGid) {
  return await asanaGet(`/projects/${projectGid}/sections`);
}

// ── Get all tasks in a section ────────────────────────────────────────────────
async function getTasksInSection(sectionGid) {
  return await asanaGet(
    `/sections/${sectionGid}/tasks?opt_fields=name,completed,due_on,priority,assignee,notes,completed_at,created_at&limit=100`
  );
}

// ── Get all tasks in a project ────────────────────────────────────────────────
async function getTasksInProject(projectGid) {
  return await asanaGet(
    `/projects/${projectGid}/tasks?opt_fields=name,completed,due_on,priority,assignee,notes,completed_at,created_at,memberships.section.name&limit=100`
  );
}

// ── Find project by name ──────────────────────────────────────────────────────
async function findProject(workspaceGid, projectName) {
  const projects = await getProjects(workspaceGid);
  return projects.find(p =>
    p.name.toLowerCase().includes(projectName.toLowerCase())
  ) || null;
}

// ── Parse client name from task name ─────────────────────────────────────────
// Task naming convention: "Client Name - task description"
function parseClientFromTask(taskName) {
  const parts = taskName.split(' - ');
  if (parts.length >= 2) {
    return parts[0].trim();
  }
  return null;
}

// ── Score a set of tasks into a Delivery score ────────────────────────────────
function scoreDelivery(tasks, scoringDate = new Date()) {
  if (!tasks || tasks.length === 0) {
    return {
      score: null,
      totalTasks: 0,
      completedOnTime: 0,
      overdueTasks: [],
      completedLate: [],
      upcomingTasks: [],
      flags: [],
      summary: 'No tasks found for this client',
    };
  }

  const today = new Date(scoringDate);
  today.setHours(0, 0, 0, 0);

  const overdueTasks    = [];
  const completedOnTime = [];
  const completedLate   = [];
  const upcomingTasks   = [];
  const flags           = [];

  for (const task of tasks) {
    const dueDate = task.due_on ? new Date(task.due_on) : null;
    const isPriority = task.name?.toLowerCase().includes('priority') ||
                       task.assignee_status === 'today' ||
                       task.priority === 'high';

    if (task.completed) {
      const completedAt = task.completed_at ? new Date(task.completed_at) : null;
      if (dueDate && completedAt && completedAt > dueDate) {
        completedLate.push({ ...task, isPriority });
      } else {
        completedOnTime.push({ ...task, isPriority });
      }
    } else {
      if (dueDate && dueDate < today) {
        overdueTasks.push({ ...task, isPriority, daysOverdue: Math.floor((today - dueDate) / (1000 * 60 * 60 * 24)) });
        const label = isPriority ? 'Priority task' : 'Task';
        flags.push(`${label} overdue: "${task.name}" (${task.due_on})`);
      } else if (dueDate) {
        upcomingTasks.push({ ...task, isPriority });
      }
    }
  }

  // ── Score calculation ──────────────────────────────────────────────────────
  // Start at 100, deduct for overdue and late completed tasks
  let score = 100;
  const totalScored = tasks.length;

  // Overdue tasks: -15 pts each, capped at -60 total
  const overdueDeduction = Math.min(overdueTasks.length * 15, 60);
  score -= overdueDeduction;

  // Priority tasks overdue: additional -10 pts each
  const priorityOverdue = overdueTasks.filter(t => t.isPriority);
  score -= Math.min(priorityOverdue.length * 10, 20);

  // Completed late: -5 pts each, capped at -20 total
  const lateDeduction = Math.min(completedLate.length * 5, 20);
  score -= lateDeduction;

  // Completion rate bonus: if all non-future tasks done on time, small bonus
  const dueTasks = tasks.filter(t => t.due_on && new Date(t.due_on) <= today);
  const completionRate = dueTasks.length > 0
    ? completedOnTime.filter(t => t.due_on && new Date(t.due_on) <= today).length / dueTasks.length
    : 1;

  if (completionRate === 1 && dueTasks.length > 0) score = Math.min(score + 5, 100);

  score = Math.max(0, Math.round(score));

  // ── Summary text ───────────────────────────────────────────────────────────
  const parts = [];
  if (overdueTasks.length > 0)   parts.push(`${overdueTasks.length} overdue`);
  if (completedLate.length > 0)  parts.push(`${completedLate.length} completed late`);
  if (completedOnTime.length > 0) parts.push(`${completedOnTime.length} on time`);
  if (upcomingTasks.length > 0)  parts.push(`${upcomingTasks.length} upcoming`);

  return {
    score,
    totalTasks:      totalScored,
    completedOnTime: completedOnTime.length,
    completedLate:   completedLate.length,
    overdueTasks,
    upcomingTasks,
    flags,
    completionRate:  Math.round(completionRate * 100),
    summary:         parts.join(' | ') || 'No due tasks this period',
  };
}

// ── Main: pull tasks for a specific client from Daily Stand Up project ────────
async function getClientDeliveryScore(workspaceGid, clientName) {
  try {
    // Find Daily Stand Up project
    const dailyStandUp = await findProject(workspaceGid, 'Daily Stand Up');
    if (!dailyStandUp) throw new Error('Daily Stand Up project not found');

    // Get all sections (one per client)
    const sections = await getSections(dailyStandUp.gid);

    // Find section matching client name
    const clientSection = sections.find(s =>
      s.name.toLowerCase().includes(clientName.toLowerCase()) ||
      clientName.toLowerCase().includes(s.name.toLowerCase())
    );

    if (!clientSection) {
      return {
        score: null,
        error: `No Asana section found for client: ${clientName}`,
        tasks: [],
      };
    }

    // Get tasks in that section
    const tasks = await getTasksInSection(clientSection.gid);
    const deliveryResult = scoreDelivery(tasks);

    return {
      ...deliveryResult,
      clientSection: clientSection.name,
      sectionGid: clientSection.gid,
    };

  } catch (err) {
    console.error('Asana error:', err.message);
    return { score: null, error: err.message, tasks: [] };
  }
}

// ── Pull tasks for ALL clients from Daily Stand Up ───────────────────────────
async function getAllClientsDelivery(workspaceGid) {
  try {
    const dailyStandUp = await findProject(workspaceGid, 'Daily Stand Up');
    if (!dailyStandUp) throw new Error('Daily Stand Up project not found');

    const sections = await getSections(dailyStandUp.gid);
    const results = {};

    for (const section of sections) {
      if (section.name === '(no section)') continue;
      const tasks = await getTasksInSection(section.gid);
      results[section.name] = {
        sectionGid: section.gid,
        ...scoreDelivery(tasks),
      };
    }

    return results;
  } catch (err) {
    console.error('Asana error:', err.message);
    throw err;
  }
}

// ── Test project: pull tasks from Test Project 5.2 ───────────────────────────
async function getTestProjectTasks(workspaceGid) {
  try {
    const testProject = await findProject(workspaceGid, 'Test Project 5.2');
    if (!testProject) throw new Error('Test Project 5.2 not found');

    const tasks = await getTasksInProject(testProject.gid);
    const scored = scoreDelivery(tasks);

    return {
      projectName: testProject.name,
      projectGid:  testProject.gid,
      tasks:       tasks.map(t => ({
        name:        t.name,
        due_on:      t.due_on,
        completed:   t.completed,
        completed_at:t.completed_at,
        isPriority:  t.name?.toLowerCase().includes('priority'),
        status: t.completed ? 'Completed' :
                (t.due_on && new Date(t.due_on) < new Date()) ? 'Overdue' : 'Upcoming',
      })),
      ...scored,
    };
  } catch (err) {
    console.error('Asana test error:', err.message);
    throw err;
  }
}

module.exports = {
  getWorkspaces,
  getProjects,
  getSections,
  getTasksInSection,
  getTasksInProject,
  findProject,
  scoreDelivery,
  getClientDeliveryScore,
  getAllClientsDelivery,
  getTestProjectTasks,
  parseClientFromTask,
};
