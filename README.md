# מתכנן כבילה Toranit: התקנה על השרת שלך

## הדרך המהירה: שרת חדש (Kamatera או כל שרת Ubuntu)
```bash
scp cameras-v1.13.0.zip root@SERVER-IP:/root/   # מהמחשב, ב-PowerShell
ssh root@SERVER-IP                             # התחברות לשרת
apt-get install -y unzip && unzip -o cameras-v1.13.0.zip && bash cameras/install.sh
```
הסקריפט שואל דומיין, אימייל וסיסמה, ומתקין: עדכונים, חומת אש, fail2ban, Docker,
Traefik עם תעודת HTTPS, את האפליקציה, וגיבוי לילי. מריצים אותו שוב לעדכון גרסה.

---

## התקנה ידנית (שרת שכבר יש בו Traefik)

האפליקציה רצה כקונטיינר נפרד, עם PostgreSQL משלה, מאחורי ה־Traefik הקיים שלך.
כל המשתמשים שתגדיר עובדים על אותם פרויקטים ואותו מחירון.

## מה יש בחבילה

| קובץ | תפקיד |
|---|---|
| `server.js` | שרת Node.js: כניסה עם סיסמה, שמירת פרויקטים, העלאת תוכניות |
| `public/index.html` | האפליקציה עצמה |
| `public/shim.js` | מחבר את האפליקציה לשרת, מסך כניסה, כפתור יציאה |
| `public/sw.js`, `manifest.webmanifest`, `icons/` | התקנה כאפליקציה (PWA) |
| `docker-compose.yml`, `Dockerfile`, `.env.example` | הרצה |

## התקנה

### 1. DNS
צור רשומת A בשם `cameras` שמצביעה לכתובת ה־IP של השרת.

### 2. העתקה לשרת
```bash
sudo mkdir -p /opt/cameras
sudo unzip cameras.zip -d /opt/cameras
cd /opt/cameras
cp .env.example .env
```

### 3. הגדרת `.env`
צור סיסמאות אקראיות:
```bash
openssl rand -hex 32   # פעם אחת ל־POSTGRES_PASSWORD, פעם נוספת ל־SESSION_SECRET
```

מצא את השמות שה־Traefik שלך משתמש בהם:
```bash
docker network ls                    # שם הרשת של Traefik → TRAEFIK_NETWORK
docker inspect traefik | grep -iE "entrypoints|certresolver"
```
הערכים הנפוצים הם `websecure` ו־`letsencrypt`, אבל הם חייבים להתאים בדיוק למה שמוגדר אצלך.

מלא ב־`ADMIN_EMAIL` וב־`ADMIN_PASSWORD` את פרטי הכניסה הראשונה (לפחות 8 תווים).

### 4. הפעלה
```bash
docker compose up -d --build
docker compose logs -f app      # צריך להופיע: listening on 3000
```
גלוש אל `https://cameras.toranit.co.il` והתחבר.

אחרי הכניסה הראשונה, מחק את השורה `ADMIN_PASSWORD` מ־`.env`. היא נחוצה רק כשאין עדיין משתמשים.

## עדכונים דרך GitHub
- **הגדרה חד־פעמית:** ב־GitHub צור מאגר פרטי (למשל `toranit-crm`). במחשב, עם `publish-update.ps1`, העלה אליו את החבילה. בשרת הרץ:
  `bash /opt/cameras/setup-git-server.sh <user>/toranit-crm`
- **כל עדכון:** במחשב `publish-update.ps1 cameras-vX.Y.Z.zip`, ובשרת `cameras-update`.
- **חזרה לגרסה קודמת:** `cameras-update v1.4.0`.
- **בדיקת הגרסה המותקנת:** `cat /opt/cameras/VERSION`, או בתחתית סרגל הצד באפליקציה.

## חיבור לסאמיט (לקוחות, הצעות מחיר, דרישות תשלום וקבלות)
1. בסאמיט: הגדרות ← חיבור מערכות / מפתחות API. העתק את **מספר החברה** ואת **מפתח ה־API**.
2. באפליקציה: **מחירון** ← "חיבור לסאמיט" ← הדבק ← **שמור** ← **בדוק חיבור**.
3. **טען סוגי מסמכים מסאמיט** ובדוק שכל סוג מחובר נכון (הצעת מחיר, דרישת תשלום, קבלה, חשבונית מס קבלה, חשבונית מס).
4. בהתחלה השאר את "להפיק כטיוטה" מסומן, הפק מסמך אחד ובדוק אותו בסאמיט. כשהכול נראה נכון, בטל את הסימון.

המפתח נשמר רק בשרת (טבלת `secrets`) ולא נשלח לדפדפן. כל פנייה לסאמיט נרשמת בטבלת `sumit_log`:
```bash
docker compose exec db psql -U cameras -c "SELECT at, endpoint, ok, message, ref FROM sumit_log ORDER BY id DESC LIMIT 20;"
```

**סנכרון:** במסך גבייה ← "סנכרן עם סאמיט". נמשכים כל המסמכים מהתקופה שנבחרה, ומסמך שנסגר בסאמיט מסומן כשולם.
השרת מסנכרן גם לבד כל שעה (120 הימים האחרונים). יומן: `docker compose logs app | grep "sumit sync"`.

**ייבוא לקוחות:** בסאמיט ייצא את רשימת הלקוחות לאקסל, ובאפליקציה: לקוחות ← "ייבוא מקובץ של סאמיט".
לקוחות קיימים מזוהים לפי מספר לקוח בסאמיט, ח.פ, אימייל או טלפון, ומתעדכנים במקום להשתכפל.

## גבייה וקריאות שירות
- **גבייה:** כל דרישת תשלום וחשבונית מס שהופקו נכנסות לרשימת הגבייה עם מועד תשלום, יתרה וימי איחור.
  "התקבל תשלום" מפיק את המסמך המתאים בסאמיט (חשבונית מס קבלה לדרישת תשלום, קבלה לחשבונית) ומעדכן את היתרה.
  "סמן כשולם" רושם תשלום בלי להפיק מסמך, למשל כשהלקוח שילם בקישור התשלום של סאמיט.
- **קריאות שירות:** פתיחה מכרטיס לקוח או ממסך הקריאות, תזמון וטכנאי, יומן עבודה, שעות וחלקים, חתימת לקוח על המסך,
  דוח שירות ב-PDF, והפקת חשבון בסאמיט לפי שעות וחלקים. מחירי שעת שירות ודמי ביקור נקבעים במסך מחירון.

## ניהול משתמשים
```bash
docker compose exec app node server.js adduser tech@toranit.co.il 'Pass1234' 'שם העובד'
docker compose exec app node server.js passwd  tech@toranit.co.il 'NewPass99'
docker compose exec app node server.js deluser tech@toranit.co.il
docker compose exec app node server.js users
```

## התקנה כאפליקציה
- **מחשב (Chrome / Edge):** אייקון ההתקנה בשורת הכתובת, או תפריט ← "התקן מתכנן כבילה".
- **אנדרואיד (Chrome):** תפריט ⋮ ← "התקנת אפליקציה".
- **אייפון (Safari):** כפתור השיתוף ← "הוסף למסך הבית".

האפליקציה נפתחת בחלון משלה עם אייקון. היא צריכה אינטרנט כדי לטעון ולשמור.

## גיבוי
```bash
# מסד הנתונים
docker compose exec -T db pg_dump -U cameras cameras | gzip > /opt/backups/cameras-$(date +%F).sql.gz
# תמונות התוכניות
docker run --rm -v cameras_uploads:/u -v /opt/backups:/b alpine tar czf /b/cameras-uploads-$(date +%F).tgz -C /u .
```
כדאי להוסיף את שתי השורות ל־cron, למשל כל לילה בשתיים: `0 2 * * *`.

שחזור:
```bash
gunzip -c cameras-2026-09-24.sql.gz | docker compose exec -T db psql -U cameras cameras
```

## עדכון גרסה
מחליפים את הקבצים (בלי `.env`) ומריצים:
```bash
docker compose up -d --build
```

## העברת הנתונים מהגרסה ב־Claude
1. בגרסה ב־Claude, מסך **מחירון** ← "העתק מחירון לגיבוי". הדבק לקובץ טקסט ושמור כ־`catalog.json`.
2. לכל פרויקט: **תוכנית** ← "פרויקטים וגיבוי" ← "העתק גיבוי". שמור כקובץ `.json`.
3. באפליקציה החדשה: **מחירון** ← "טען מחירון", ובתוכנית ← "ייבוא גיבוי" לכל פרויקט.

את תמונות הרקע של התוכניות צריך לטעון מחדש. השרטוט, הכבלים, התמחור והמעקב עוברים כמו שהם.

## פתרון תקלות
- **404 מ־Traefik:** בדוק ש־`TRAEFIK_NETWORK` ו־`TRAEFIK_ENTRYPOINT` תואמים בדיוק, ושהרשת מוגדרת external.
- **אין תעודת SSL:** בדוק את `TRAEFIK_CERTRESOLVER`, ושרשומת ה־DNS כבר מצביעה לשרת.
- **נכנס ומיד חוזר למסך הכניסה:** האתר נפתח ב־http במקום https. אפשר גם לבדוק את `COOKIE_SECURE`.
- **לוגים:** `docker compose logs app` או `docker compose logs db`.

## אבטחה
- הסיסמאות מוצפנות ב־scrypt. ההתחברות נשמרת 30 יום בעוגייה חתומה.
- אחרי 10 ניסיונות כניסה כושלים מאותה כתובת, הכניסה נחסמת לרבע שעה.
- כל פעולת שינוי דורשת כותרת ייעודית שמונעת CSRF.
- מסד הנתונים לא חשוף מחוץ לשרת. רק האפליקציה מחוברת לרשת של Traefik.
