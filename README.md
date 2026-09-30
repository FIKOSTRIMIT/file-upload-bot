# 📤 Private File Upload → Telegram Bot

Приватный сайт для загрузки фото и видео, которые автоматически пересылаются в ваш Telegram.

## ✨ Возможности

- 🔒 **Приватный доступ** — только по секретной ссылке
- 📸 **Фото** (JPG, PNG, WebP, HEIC) и 🎥 **видео** (MP4, MOV, WebM)
- 📱 **Drag & drop** + вставка из буфера обмена (Ctrl+V)
- ⚡ **Прямая отправка** в Telegram Bot API (без сохранения на диске)
- 🐳 **Docker** — деплой одной командой
- 📊 **Rate limiting** — защита от спама
- 📱 **Мобильно-адаптивный** интерфейс

---

## 🚀 Быстрый старт (на VPS)

### 1. Подготовка сервера
```bash
# Установите Docker и Docker Compose
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
newgrp docker  # или перезайдите в SSH
```

### 2. Создание Telegram бота
1. Напишите **@BotFather** → `/newbot`
2. Скопируйте **токен** (вида `123456789:ABC...`)
3. Узнайте свой **Chat ID**:
   - Напишите **@userinfobot** или **@getmyid_bot**
   - Или перешлите любое сообщение боту **@RawDataBot** → ищите `"chat":{"id":123456789}`

### 3. Настройка проекта
```bash
# Клонируйте/скопируйте файлы проекта на сервер
cd file-upload-bot

# Создайте .env из примера
cp .env.example .env

# Отредактируйте .env
nano .env
```

**Обязательные переменные в `.env`:**
```env
BOT_TOKEN=1234567890:AAExxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
CHAT_ID=123456789
SECRET_PATH=upload-mysecret123  # любая случайная строка
```

### 4. Деплой
```bash
chmod +x deploy.sh
./deploy.sh
```

После успешного деплоя вы увидите:
```
✅ Деплой успешен!
🔗 Ссылка для загрузки: http://YOUR_IP:3000/upload-mysecret123
```

---

## 🌐 Настройка домена + HTTPS (рекомендуемо)

### 1. DNS
Создайте A-запись: `upload.yourdomain.com` → IP вашего сервера

### 2. SSL через Let's Encrypt (Certbot)
```bash
# Установите certbot
sudo apt install certbot

# Получите сертификат (standalone режим, временно остановите контейнер)
docker compose down
sudo certbot certonly --standalone -d upload.yourdomain.com
docker compose up -d
```

### 3. Nginx reverse proxy
Раскомментируйте секцию `nginx` в `docker-compose.yml` и обновите `nginx.conf`:
- Замените `YOUR_DOMAIN.COM` на ваш домен
- Пути к сертификатам: `/etc/letsencrypt/live/yourdomain.com/...`

```bash
docker compose up -d nginx
```

Теперь сайт доступен по **https://upload.yourdomain.com/upload-mysecret123**

---

## 📂 Структура проекта

```
file-upload-bot/
├── server.js           # Express сервер + Telegram API
├── public/
│   └── index.html      # Фронтенд (загрузка, превью, прогресс)
├── Dockerfile          # Docker образ
├── docker-compose.yml  # Оркестрация
├── nginx.conf          # Nginx конфиг (опционально)
├── .env.example        # Пример переменных
├── deploy.sh           # Скрипт деплоя
└── uploads/            # Временные файлы (автоочистка)
```

---

## ⚙️ Переменные окружения

| Переменная | Обязательна | По умолчанию | Описание |
|------------|-------------|--------------|----------|
| `BOT_TOKEN` | ✅ | — | Токен от @BotFather |
| `CHAT_ID` | ✅ | — | Ваш Telegram ID (куда приходят файлы) |
| `PORT` | ❌ | `3000` | Порт сервера |
| `SECRET_PATH` | ❌ | `upload-<random>` | Секретный путь в URL |
| `MAX_FILE_SIZE` | ❌ | `52428800` (50MB) | Макс. размер файла в байтах |

---

## 🛠 Команды управления

```bash
# Логи в реальном времени
docker compose logs -f

# Перезапуск
docker compose restart

# Остановка
docker compose down

# Обновление (после git pull / изменений)
./deploy.sh

# Проверка здоровья
curl http://localhost:3000/health
```

---

## 🔒 Безопасность

- **Секретная ссылка** — единственная защита (подберите длинный `SECRET_PATH`)
- **Rate limiting** — 10 запросов/мин с одного IP
- **Валидация файлов** — только изображения/видео по MIME и расширению
- **Размер файла** — лимит 50 МБ (настраивается)
- **Автоудаление** — файлы удаляются с диска сразу после отправки в Telegram

> ⚠️ Для максимальной приватности используйте **HTTPS** (см. раздел выше).

---

## 🐛 Troubleshooting

### Файл не приходит в Telegram
- Проверьте `BOT_TOKEN` и `CHAT_ID` в `.env`
- Убедитесь, что бот **не заблокирован** и вы с ним **начали диалог** (/start)
- Проверьте логи: `docker compose logs -f`

### Ошибка "File too large"
- Увеличьте `MAX_FILE_SIZE` в `.env` (в байтах)
- Для видео > 50 МБ Telegram API требует **multipart upload** (сложнее) — текущий лимит 50 МБ

### Сайт не открывается
- Проверьте, что порт 3000 открыт в фаерволе: `sudo ufw allow 3000`
- Проверьте health: `curl http://localhost:3000/health`

### Нужно загружать файлы > 50 МБ
Telegram Bot API имеет лимит 50 МБ на `sendVideo`/`sendPhoto`. Для больших файлов нужно использовать:
- **Telegram Bot API local server** (сложнее)
- Или загружать на файлообменник и отправлять ссылку

---

## 📄 Лицензия

MIT — используйте как хотите.

---

## 💡 Идеи для доработки

- [ ] Поддержка альбомов (multiple files)
- [ ] Текстовое сообщение к файлу
- [ ] QR-код на странице для удобства с телефона
- [ ] Админ-панель с историей загрузок
- [ ] Webhook для получения file_id от Telegram