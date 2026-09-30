#!/bin/bash
# deploy.sh - Скрипт для деплоя на VPS
# Использование: chmod +x deploy.sh && ./deploy.sh

set -e

echo "🚀 Деплой File Upload Bot"

# Проверка .env
if [ ! -f .env ]; then
    echo "❌ Файл .env не найден!"
    echo "Скопируйте .env.example в .env и заполните:"
    echo "  cp .env.example .env"
    echo "  nano .env"
    exit 1
fi

# Проверка обязательных переменных
source .env
if [ -z "$BOT_TOKEN" ] || [ -z "$CHAT_ID" ]; then
    echo "❌ BOT_TOKEN и CHAT_ID должны быть заданы в .env"
    exit 1
fi

echo "✅ Переменные окружения проверены"

# Остановка старых контейнеров
echo "🛑 Остановка старых контейнеров..."
docker compose down 2>/dev/null || true

# Сборка и запуск
echo "🔨 Сборка образа..."
docker compose build --no-cache

echo "▶️ Запуск..."
docker compose up -d

# Ожидание готовности
echo "⏳ Ожидание запуска..."
sleep 5

# Проверка здоровья
if curl -sf http://localhost:3000/health > /dev/null; then
    echo ""
    echo "✅ Деплой успешен!"
    echo ""
    SECRET_PATH=$(docker compose exec -T app printenv SECRET_PATH 2>/dev/null | tr -d '\r' || grep SECRET_PATH .env | cut -d= -f2)
    echo "🔗 Ссылка для загрузки: http://$(curl -s ifconfig.me 2>/dev/null || echo 'YOUR_SERVER_IP'):3000/${SECRET_PATH}"
    echo "❤️  Health check: http://localhost:3000/health"
    echo ""
    echo "📋 Логи: docker compose logs -f"
else
    echo "❌ Сервер не запустился. Проверьте логи:"
    docker compose logs
    exit 1
fi