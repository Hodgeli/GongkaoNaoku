#!/usr/bin/env bash
# 本地改动 ↔ GitHub 同步，并让 systemd 用户服务加载新代码
set -euo pipefail
cd "$(dirname "$0")"

SERVICE="${KAOGONG_SERVICE:-gongkao.service}"
BRANCH="${KAOGONG_BRANCH:-master}"

restart_service() {
  if systemctl --user is-active --quiet "$SERVICE"; then
    systemctl --user restart "$SERVICE"
    sleep 1
    echo "已重启 $SERVICE"
  else
    echo "$SERVICE 未在运行，跳过重启（下次启动自然生效）"
  fi
}

usage() {
  cat <<'EOF'
用法:
  ./sync.sh push "提交说明"   提交全部改动 → 推送到 origin → 重启服务
  ./sync.sh pull              拉取远程改动（rebase）→ 重启服务
  ./sync.sh restart           只重启服务（改完 server.py 后让它生效）

环境变量: KAOGONG_SERVICE（默认 gongkao.service）、KAOGONG_BRANCH（默认 master）
EOF
}

case "${1:-}" in
  push)
    msg="${2:-}"
    [ -n "$msg" ] || { echo "缺少提交说明"; usage; exit 1; }
    git add -A
    if git diff --cached --quiet; then
      echo "没有需要提交的改动"
    else
      git commit -m "$msg"
    fi
    git push origin "HEAD:$BRANCH"
    restart_service
    ;;
  pull)
    git pull --rebase origin "$BRANCH"
    restart_service
    ;;
  restart)
    restart_service
    ;;
  *)
    usage
    exit 1
    ;;
esac
