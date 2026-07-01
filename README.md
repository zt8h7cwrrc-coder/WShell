# WShell

加密直连远程 Shell —— SSH 的稳定替代方案。

## 为什么做这个？

SSH 在网络波动时容易断连。WShell 用 WebSocket + libsodium 加密，解决了这个问题：

| 特性 | SSH | WShell |
|------|-----|--------|
| 协议 | TCP 直连 | WebSocket |
| 加密 | 内置 | libsodium (XChaCha20-Poly1305) |
| 断线重连 | 手动 | 自动（指数退避） |
| 会话保持 | 断了就丢 | 服务端保留 |
| 心跳检测 | TCP keepalive（慢） | 应用层 15 秒 |
| 消息缓冲 | 无 | 有 |

## 架构

```
┌──────────────┐         ┌──────────────┐
│  客户端      │◄──TLS──►│  服务端      │
│  (你的电脑)  │  或      │  (VPS)       │
│              │  普通     │              │
│  - CLI 交互  │  WS      │  - Shell     │
│  - 自动重连  │         │  - 命令执行   │
│              │         │  - 文件传输   │
└──────────────┘         └──────────────┘
```

认证后所有通信都经过 libsodium 加密：
- 密钥通过 auth token 派生（`crypto_kdf`）
- 每条消息使用随机 24 字节 nonce
- XChaCha20-Poly1305 认证加密

## 安装

需要 Node.js >= 18。

```bash
git clone <repo-url>
cd wshell
npm run build
```

`npm run build` 会自动安装依赖并编译 TypeScript。

## 快速开始

### 1. 服务端（部署在 VPS 上）

```bash
# 添加用户（会生成 token，记下来）
node dist/cli/server.js user add admin -p mypassword

# 启动服务
node dist/cli/server.js start
```

输出示例：
```
  User "admin" created.
  Token: a1b2c3d4e5f6...

  Add this host to your client:
    wshell config add myhost admin@<服务器IP>
  Then edit ~/.wshell/config.json to paste the token.
```

**重要：把 token 保存好，客户端连接时需要。**

### 2. 客户端（你的电脑上）

#### 方式一：直接用 token 连接

```bash
node dist/cli/client.js --token <token> --server ws://你的VPS:7700 admin@你的VPS
```

#### 方式二：保存配置后连接

```bash
# 保存主机配置
node dist/cli/client.js config add myhost admin@你的VPS

# 编辑配置文件，填入 token
# ~/.wshell/config.json:
# {
#   "hosts": {
#     "myhost": {
#       "user": "admin",
#       "host": "你的VPS",
#       "port": 7700,
#       "token": "a1b2c3d4e5f6..."
#     }
#   }
# }

# 之后直接用名字连接
node dist/cli/client.js myhost
```

## 使用说明

### 客户端命令（wshell）

```bash
# 交互式 Shell
wshell <user@host>
wshell <user@host:port>         # 指定端口
wshell <name>                   # 用保存的配置名

# 执行单条命令
wshell <user@host> exec "ls -la"
wshell <user@host> exec "df -h"

# 上传文件
wshell <user@host> put ./local.txt /remote/path.txt

# 下载文件
wshell <user@host> get /remote/path.txt ./local.txt

# 生成新 token
wshell keygen

# 查看帮助
wshell help
```

### 交互式 Shell 内部命令

连接成功后进入交互模式，支持以下命令：

```
wshell> /shell                    # 打开交互式终端
wshell> /exec ls -la              # 执行命令
wshell> /put ./file.txt /tmp/f    # 上传文件
wshell> /get /tmp/f ./file.txt    # 下载文件
wshell> /quit                     # 退出
```

直接输入内容会发送到 Shell 会话中。

### 服务端命令（wshelld）

```bash
# 用户管理
node dist/cli/server.js user add <name> -p <password>    # 添加用户
node dist/cli/server.js user list                         # 列出用户
node dist/cli/server.js user remove <name>                # 删除用户

# 启动服务
node dist/cli/server.js start                             # 启动守护进程

# 选项
  -P, --port <port>     监听端口（默认 7700）
  -H, --host <host>     监听地址（默认 0.0.0.0）
  -a, --auth <file>     认证文件路径（默认 ./wshell-auth.json）

# 查看帮助
node dist/cli/server.js help
```

### 配置文件

配置保存在 `~/.wshell/config.json`：

```json
{
  "hosts": {
    "myhost": {
      "user": "admin",
      "host": "123.45.67.89",
      "port": 7700,
      "token": "你的token"
    },
    "dev": {
      "user": "dev",
      "host": "10.0.0.1",
      "port": 7700,
      "token": "另一个token"
    }
  }
}
```

## 安全设计

| 层级 | 机制 |
|------|------|
| 认证 | bcrypt 密码哈希（10 轮） |
| Token | 随机生成，存储为 SHA-256 指纹 |
| 加密 | libsodium XChaCha20-Poly1305 |
| 密钥派生 | `crypto_kdf` 从 token 派生子密钥 |
| 消息格式 | `[0x00 标志][4字节 nonce 长度][24字节 nonce][密文]` |
| 认证前 | 明文 JSON |
| 认证后 | 全部加密 |

## 项目结构

```
wshell/
├── src/
│   ├── cli/
│   │   ├── client.ts         # 客户端 CLI
│   │   ├── server.ts         # 服务端 CLI
│   │   └── start.ts          # 服务端启动入口
│   ├── server/
│   │   └── index.ts          # TunnelServer 类
│   ├── client/
│   │   └── index.ts          # TunnelClient 类
│   ├── crypto/
│   │   ├── index.ts          # libsodium 加密封装
│   │   └── sodium-native.d.ts  # sodium-native 类型声明
│   └── shared/
│       ├── protocol.ts       # 消息格式定义
│       ├── auth.ts           # 认证模块
│       └── config.ts         # 配置管理
├── scripts/
│   └── generate-licenses.cjs # 第三方许可证生成脚本
├── THIRD_PARTY_LICENSES/     # 第三方许可证（自动生成）
├── LICENSE                   # MIT 许可证
├── package.json
├── tsconfig.json
└── README.md
```

## 开发

```bash
# 开发模式运行（无需编译）
npm run dev:server            # 启动服务端
npm run dev:client            # 运行客户端

# 编译
npm run build

# 清理编译产物
npm run clean

# 重新生成第三方许可证
npm run licenses
```

## 部署建议

### 服务端部署

```bash
# 在 VPS 上
git clone <repo-url> && cd wshell
npm run build
node dist/cli/server.js user add admin -p <密码>

# 用 pm2 或 systemd 保持运行
pm2 start node -- dist/cli/server.js start
# 或
# 用 screen/tmux
screen -S wshelld node dist/cli/server.js start
```

### 防火墙

确保 VPS 的 7700 端口（或你指定的端口）对外开放：

```bash
# Ubuntu/Debian
ufw allow 7700/tcp

# CentOS/RHEL
firewall-cmd --permanent --add-port=7700/tcp
firewall-cmd --reload
```

### 反向代理（可选）

如果需要通过域名访问，可以用 Nginx 做 WebSocket 代理：

```nginx
server {
    listen 443 ssl;
    server_name shell.example.com;

    ssl_certificate     /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://127.0.0.1:7700;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 86400;
    }
}
```

客户端连接时用：

```bash
wshell --server wss://shell.example.com admin@shell.example.com
```

## License

MIT — see [LICENSE](LICENSE)

Third-party licenses — see [THIRD_PARTY_LICENSES/](THIRD_PARTY_LICENSES/)
