#!/bin/sh

echo "========================================="
echo "   正在初始化 Xray-Core 出站加密管道...   "
echo "========================================="

# 写入 Xray 节点参数
cp /app/xray.json.template /etc/xray/config.json

# 异步拉起 Xray 引擎
xray run -c /etc/xray/config.json &

# 给隧道一点建立握手的时间
sleep 3

echo "Xray 隧道代理就绪，正在注入底层出站环境变量..."
# 核心：通过环境变量，强行接管 Node.js 内置的 fetch 底层网络层，让它强制通过本地 Socks5 走香港节点访问外网
export HTTP_PROXY="socks5://127.0.0.1:10808"
export HTTPS_PROXY="socks5://127.0.0.1:10808"

# 启动 Node.js 处理核心
node index.js &

echo "正在启动前置 Nginx 网络交换矩阵..."
# 启动前置 Nginx
nginx -g "daemon off;"
