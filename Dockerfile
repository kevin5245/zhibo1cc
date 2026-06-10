FROM node:20-alpine

# 安装 nginx 容器组件、curl 与系统证书
RUN apk add --no-cache nginx ca-certificates curl

# 全自动判断 CPU 架构（支持常见的 x86_64 服务器或 树莓派/甲骨文 ARM 架构），下载对应版本的 Xray-core
RUN ARCH=$(uname -m) && \
    if [ "$ARCH" = "x86_64" ]; then XRAY_ARCH="64"; \
    elif [ "$ARCH" = "aarch64" ]; then XRAY_ARCH="arm64-v8a"; \
    else XRAY_ARCH="64"; fi && \
    curl -L -o /tmp/xray.zip "https://github.com/XTLS/Xray-core/releases/latest/download/Xray-linux-${XRAY_ARCH}.zip" && \
    mkdir -p /opt/xray && \
    unzip /tmp/xray.zip -d /opt/xray && \
    ln ( -s /opt/xray/xray /usr/local/bin/xray || ln -s /opt/xray/xray /usr/bin/xray ) && \
    rm -rf /tmp/xray.zip

WORKDIR /app

# 初始化 Nginx 和 Xray 系统的运行目录
RUN mkdir -p /etc/xray /run/nginx

# 拷贝并冻结依赖
COPY package.json ./
RUN npm install --production

# 导入所有业务核心组件
COPY index.js ./
COPY nginx.conf /etc/nginx/nginx.conf
COPY xray.json.template ./
COPY entrypoint.sh ./

RUN chmod +x entrypoint.sh

# 暴露唯一的统一流量出入口
EXPOSE 80

CMD ["./entrypoint.sh"]
