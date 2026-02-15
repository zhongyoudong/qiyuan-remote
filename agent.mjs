#!/usr/bin/env node

/**
 * 起源远程 Agent - 让AI助手远程读写你的项目文件
 * 用法: npx qiyuan-remote /工作区路径 [--host IP] [--port 端口] [--name 名称]
 */

import WebSocket from 'ws';
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync } from 'fs';
import { join, resolve, relative, isAbsolute } from 'path';
import { hostname, platform } from 'os';
import { execSync } from 'child_process';

// ========== 参数解析 ==========
const args = process.argv.slice(2);
let workDir = null;
let serverHost = '129.204.22.176';
let serverPort = 1004;
let agentName = hostname();

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--host' && args[i + 1]) { serverHost = args[++i]; continue; }
  if (args[i] === '--port' && args[i + 1]) { serverPort = parseInt(args[++i]); continue; }
  if (args[i] === '--name' && args[i + 1]) { agentName = args[++i]; continue; }
  if (args[i] === '--help' || args[i] === '-h') { printHelp(); process.exit(0); }
  if (!args[i].startsWith('-') && !workDir) { workDir = args[i]; }
}

if (!workDir) {
  console.log('\n  起源远程 Agent v1.0.0\n');
  console.log('  用法: npx qiyuan-remote <工作区路径> [选项]\n');
  console.log('  选项:');
  console.log('    --host <IP>    服务器地址 (默认: 129.204.22.176)');
  console.log('    --port <端口>  服务器端口 (默认: 1004)');
  console.log('    --name <名称>  Agent名称 (默认: 主机名)\n');
  console.log('  示例: npx qiyuan-remote ./my-project');
  console.log('        npx qiyuan-remote /home/user/code --name my-pc\n');
  process.exit(1);
}

workDir = resolve(workDir);
if (!existsSync(workDir)) {
  console.error(`  错误: 工作区路径不存在: ${workDir}`);
  process.exit(1);
}

function printHelp() {
  console.log('\n  起源远程 Agent - 让AI助手远程读写你的项目文件\n');
  console.log('  用法: npx qiyuan-remote <工作区路径> [选项]\n');
}

// ========== 安全检查 ==========
function safePath(p) {
  const full = isAbsolute(p) ? resolve(p) : resolve(workDir, p);
  if (!full.startsWith(workDir)) throw new Error('路径越权: 不允许访问工作区外的文件');
  return full;
}

// ========== 指令处理 ==========
function handleRequest(msg) {
  try {
    switch (msg.action) {
      case 'readFile': {
        const fp = safePath(msg.path);
        if (!existsSync(fp)) return { success: false, error: '文件不存在' };
        const stat = statSync(fp);
        if (stat.size > 5 * 1024 * 1024) return { success: false, error: '文件过大(>5MB)' };
        const content = readFileSync(fp, 'utf-8');
        return { success: true, content, size: stat.size };
      }
      case 'writeFile': {
        const fp = safePath(msg.path);
        const dir = join(fp, '..');
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        writeFileSync(fp, msg.content, 'utf-8');
        return { success: true };
      }
      case 'listDir': {
        const dp = safePath(msg.path || '.');
        if (!existsSync(dp)) return { success: false, error: '目录不存在' };
        const entries = readdirSync(dp, { withFileTypes: true }).map(e => ({
          name: e.name, type: e.isDirectory() ? 'dir' : 'file',
          size: e.isFile() ? statSync(join(dp, e.name)).size : undefined
        }));
        return { success: true, entries };
      }
      case 'runCommand': {
        const cmdTimeout = msg.timeout || 120000;
        try {
          const output = execSync(msg.command, {
            cwd: msg.cwd || workDir, timeout: cmdTimeout, maxBuffer: 5 * 1024 * 1024,
            encoding: 'utf-8', shell: true
          });
          return { success: true, output };
        } catch (e) {
          return { success: false, error: e.message, output: e.stdout || '', stderr: e.stderr || '' };
        }
      }
      default:
        return { success: false, error: `未知指令: ${msg.action}` };
    }
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ========== WebSocket 连接 ==========
const wsUrl = `ws://${serverHost}:${serverPort}/ws`;
let ws = null;
let reconnectTimer = null;

function connect() {
  console.log(`  连接到 ${wsUrl} ...`);
  ws = new WebSocket(wsUrl);

  ws.on('open', () => {
    console.log(`  ✓ 已连接到服务器`);
    console.log(`  ✓ Agent名称: ${agentName}`);
    console.log(`  ✓ 工作区: ${workDir}`);
    console.log(`  等待指令中...\n`);
    ws.send(JSON.stringify({
      type: 'register', name: agentName,
      workDir, platform: `${platform()}`
    }));
  });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'registered') {
        console.log(`  [注册成功] 名称: ${msg.name}`);
        return;
      }
      if (msg.type === 'request') {
        console.log(`  [指令] ${msg.action} ${msg.path || msg.command || ''}`);
        const result = handleRequest(msg);
        ws.send(JSON.stringify({ type: 'response', requestId: msg.requestId, ...result }));
        console.log(`  [完成] ${result.success ? '成功' : '失败: ' + result.error}`);
      }
    } catch (e) {
      console.error(`  [错误] ${e.message}`);
    }
  });

  ws.on('close', () => {
    console.log('  连接断开，5秒后重连...');
    scheduleReconnect();
  });

  ws.on('error', (err) => {
    console.error(`  连接错误: ${err.message}`);
  });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, 5000);
}

// 心跳
setInterval(() => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'heartbeat' }));
  }
}, 30000);

// 启动
console.log('\n  起源远程 Agent v1.0.0');
console.log('  ─────────────────────');
connect();

// 优雅退出
process.on('SIGINT', () => {
  console.log('\n  正在断开...');
  if (ws) ws.close();
  process.exit(0);
});
