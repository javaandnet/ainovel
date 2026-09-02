#!/bin/bash
# 释放指定端口占用的进程
# 用法: ./kill-port.sh <端口号> [端口号2 ...]

if [ $# -eq 0 ]; then
  echo "用法: $0 <端口号> [端口号2 ...]"
  echo "示例: $0 3000 8080"
  exit 1
fi

for PORT in "$@"; do
  PID=$(lsof -ti:"$PORT" 2>/dev/null)
  if [ -z "$PID" ]; then
    echo "端口 $PORT 未被占用"
  else
    kill -9 $PID 2>/dev/null
    if [ $? -eq 0 ]; then
      echo "已关闭端口 $PORT (PID: $PID)"
    else
      echo "关闭端口 $PORT 失败 (PID: $PID)"
    fi
  fi
done
