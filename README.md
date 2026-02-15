# 起源远程 Qiyuan Remote

让AI助手远程读写你的项目文件。

## 一条命令接入

```bash
npx github:zhongyoudong/qiyuan-remote /你的工作区路径
```

如需指定服务器地址：

```bash
npx github:zhongyoudong/qiyuan-remote /你的工作区路径 --host 你的服务器IP
```

## 参数

| 参数 | 说明 | 默认值 |
|------|------|--------|
| 第一个参数 | 工作区路径 | 必填 |
| `--host` | 服务器地址 | 129.204.22.176 |
| `--port` | 服务器端口 | 1004 |
| `--name` | Agent名称 | 主机名 |

## 要求

- Node.js 18+

## 工作原理

1. 你的电脑运行 Agent，通过 WebSocket 连接到起源服务器
2. AI助手通过服务器向 Agent 下发文件读写指令
3. Agent 在你指定的工作区内执行操作并返回结果
4. 所有操作限制在工作区目录内，不会越权访问

## License

MIT
