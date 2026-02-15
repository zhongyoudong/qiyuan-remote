import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = 1004;

// 存储已连接的 agent
const agents = new Map(); // name -> { ws, workDir, connectedAt, lastHeartbeat }

// ========== HTTP 服务 ==========
const server = createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  // API 路由
  if (url.pathname === '/api/agents') return handleAgentsList(req, res);
  if (url.pathname === '/api/exec') return handleExec(req, res);
  if (url.pathname === '/api/read') return handleRead(req, res);
  if (url.pathname === '/api/write') return handleWrite(req, res);
  if (url.pathname === '/api/list') return handleList(req, res);
  if (url.pathname === '/api/run') return handleRun(req, res);

  // 前端页面
  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(getIndexHTML());
    return;
  }

  res.writeHead(404); res.end('Not Found');
});

// ========== WebSocket 服务 ==========
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  let agentName = null;
  console.log('[WS] 新连接');

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);

      if (msg.type === 'register') {
        agentName = msg.name || `agent-${Date.now()}`;
        agents.set(agentName, {
          ws, workDir: msg.workDir, connectedAt: new Date().toISOString(),
          lastHeartbeat: Date.now(), platform: msg.platform || 'unknown'
        });
        console.log(`[Agent] "${agentName}" 已注册, 工作区: ${msg.workDir}`);
        ws.send(JSON.stringify({ type: 'registered', name: agentName }));
        return;
      }

      if (msg.type === 'heartbeat') {
        const agent = agents.get(agentName);
        if (agent) agent.lastHeartbeat = Date.now();
        return;
      }

      // 响应消息 (agent 返回执行结果)
      if (msg.type === 'response' && msg.requestId) {
        const resolve = pendingRequests.get(msg.requestId);
        if (resolve) {
          resolve(msg);
          pendingRequests.delete(msg.requestId);
        }
      }
    } catch (e) {
      console.error('[WS] 消息解析错误:', e.message);
    }
  });

  ws.on('close', () => {
    if (agentName) {
      agents.delete(agentName);
      console.log(`[Agent] "${agentName}" 已断开`);
    }
  });
});

// ========== 请求/响应机制 ==========
const pendingRequests = new Map(); // requestId -> resolve
let requestCounter = 0;

function sendToAgent(agentName, action, payload, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const agent = agents.get(agentName);
    if (!agent) return reject(new Error(`Agent "${agentName}" 未连接`));

    const requestId = `req-${++requestCounter}`;
    const timer = setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new Error('请求超时'));
    }, timeout);

    pendingRequests.set(requestId, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });

    agent.ws.send(JSON.stringify({ type: 'request', requestId, action, ...payload }));
  });
}

// ========== API 处理函数 ==========
function handleAgentsList(req, res) {
  const list = [];
  for (const [name, info] of agents) {
    list.push({
      name, workDir: info.workDir, platform: info.platform,
      connectedAt: info.connectedAt,
      alive: Date.now() - info.lastHeartbeat < 60000
    });
  }
  json(res, { agents: list });
}

async function handleExec(req, res) {
  const body = await readBody(req);
  const { agent, action, ...payload } = body;
  if (!agent) return json(res, { error: '缺少 agent 参数' }, 400);
  try {
    const result = await sendToAgent(agent, action, payload);
    json(res, result);
  } catch (e) {
    json(res, { error: e.message }, 500);
  }
}

async function handleRead(req, res) {
  const body = await readBody(req);
  if (!body.agent || !body.path) return json(res, { error: '缺少 agent 或 path' }, 400);
  try {
    const result = await sendToAgent(body.agent, 'readFile', { path: body.path });
    json(res, result);
  } catch (e) { json(res, { error: e.message }, 500); }
}

async function handleWrite(req, res) {
  const body = await readBody(req);
  if (!body.agent || !body.path || body.content === undefined)
    return json(res, { error: '缺少参数' }, 400);
  try {
    const result = await sendToAgent(body.agent, 'writeFile', { path: body.path, content: body.content });
    json(res, result);
  } catch (e) { json(res, { error: e.message }, 500); }
}

async function handleList(req, res) {
  const body = await readBody(req);
  if (!body.agent) return json(res, { error: '缺少 agent' }, 400);
  try {
    const result = await sendToAgent(body.agent, 'listDir', { path: body.path || '.' });
    json(res, result);
  } catch (e) { json(res, { error: e.message }, 500); }
}

async function handleRun(req, res) {
  const body = await readBody(req);
  if (!body.agent || !body.command) return json(res, { error: '缺少参数' }, 400);
  try {
    const result = await sendToAgent(body.agent, 'runCommand', { command: body.command }, 60000);
    json(res, result);
  } catch (e) { json(res, { error: e.message }, 500); }
}

// ========== 工具函数 ==========
function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve({}); } });
  });
}

// ========== 前端页面 ==========
function getIndexHTML() {
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>起源远程 - Qiyuan Remote</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f5f7fa;color:#1a1a2e;min-height:100vh}
.container{max-width:800px;margin:0 auto;padding:40px 20px}
h1{font-size:28px;margin-bottom:8px}
.subtitle{color:#666;margin-bottom:32px}
.card{background:#fff;border-radius:12px;padding:24px;margin-bottom:20px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
.card h2{font-size:18px;margin-bottom:12px}
.code-block{background:#1a1a2e;color:#e0e0e0;padding:16px;border-radius:8px;font-family:'Fira Code',monospace;font-size:14px;overflow-x:auto;margin:12px 0;position:relative}
.code-block .copy{position:absolute;top:8px;right:8px;background:#333;color:#fff;border:none;padding:4px 10px;border-radius:4px;cursor:pointer;font-size:12px}
.code-block .copy:hover{background:#555}
.agent-list{margin-top:12px}
.agent-item{display:flex;align-items:center;gap:12px;padding:12px;background:#f8f9fa;border-radius:8px;margin-bottom:8px}
.dot{width:10px;height:10px;border-radius:50%}
.dot.online{background:#22c55e}
.dot.offline{background:#ef4444}
.agent-info{flex:1}
.agent-name{font-weight:600}
.agent-meta{font-size:13px;color:#666}
.empty{color:#999;text-align:center;padding:20px}
.refresh-btn{background:#111827;color:#fff;border:none;padding:8px 16px;border-radius:6px;cursor:pointer;font-size:14px}
.refresh-btn:hover{background:#374151}
.steps{counter-reset:step}
.steps li{counter-increment:step;list-style:none;padding:8px 0 8px 36px;position:relative}
.steps li::before{content:counter(step);position:absolute;left:0;top:8px;width:24px;height:24px;background:#111827;color:#fff;border-radius:50%;text-align:center;line-height:24px;font-size:13px}
</style></head><body>
<div class="container">
<h1>起源远程 Qiyuan Remote</h1>
<p class="subtitle">让AI助手远程读写你的项目文件</p>

<div class="card"><h2>快速开始</h2>
<ol class="steps">
<li>确保你的电脑已安装 <b>Node.js 18+</b></li>
<li>打开终端，运行以下命令：
<div class="code-block"><button class="copy" onclick="navigator.clipboard.writeText(this.nextElementSibling.textContent)">复制</button><code>npx qiyuan-remote /你的工作区路径</code></div>
</li>
<li>如果需要指定服务器地址：
<div class="code-block"><button class="copy" onclick="navigator.clipboard.writeText(this.nextElementSibling.textContent)">复制</button><code>npx qiyuan-remote /你的工作区路径 --host 129.204.22.176</code></div>
</li>
<li>连接成功后，告诉牛牛你的 Agent 名称即可开始远程协作</li>
</ol></div>

<div class="card"><h2>已连接的 Agent</h2>
<div id="agents" class="agent-list"><div class="empty">加载中...</div></div>
<button class="refresh-btn" onclick="loadAgents()" style="margin-top:12px">刷新</button>
</div></div>

<script>
async function loadAgents(){
  try{
    const r=await fetch('/api/agents');const d=await r.json();const el=document.getElementById('agents');
    if(!d.agents||d.agents.length===0){el.innerHTML='<div class="empty">暂无 Agent 连接</div>';return}
    el.innerHTML=d.agents.map(a=>\`<div class="agent-item">
      <div class="dot \${a.alive?'online':'offline'}"></div>
      <div class="agent-info"><div class="agent-name">\${a.name}</div>
      <div class="agent-meta">\${a.platform} · \${a.workDir} · 连接于 \${new Date(a.connectedAt).toLocaleString()}</div></div></div>\`).join('');
  }catch(e){document.getElementById('agents').innerHTML='<div class="empty">加载失败</div>'}
}
loadAgents(); setInterval(loadAgents,10000);
</script></body></html>`;
}

// ========== 启动 ==========
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  起源远程服务已启动`);
  console.log(`  本地访问: http://localhost:${PORT}`);
  console.log(`  等待 Agent 连接...\n`);
});
