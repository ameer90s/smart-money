# إعداد Smart Money (من الجوال)

المفاتيح ما تنكتب في الكود ولا ترسلها في أي محادثة. كلها تنحط في أسرار GitHub وإعدادات Vercel فقط.

## 1. المستودع
1. GitHub ← **New repository** ← الاسم `smart-money` ← **Public**. لازم يكون عام عشان دقائق GitHub Actions تبقى مجانية بدون حد.
2. ارفع كل ملفات المشروع بنفس ترتيب المجلدات.

## 2. Gist خاص للبيانات الحية
1. افتح gist.github.com ← اسم الملف `settings.json` ← المحتوى `{}`.
2. اختر **Create secret gist**.
3. انسخ الـ ID، وهو آخر جزء في الرابط بعد اسم حسابك.

## 3. توكن للبيانات (Fine-grained)
GitHub ← Settings ← Developer settings ← Personal access tokens ← **Fine-grained tokens** ← Generate:
- **الاسم:** `smart-money-data`، والصلاحية سنة.
- **Repository access:** Only select ← `smart-money`، والصلاحية **Contents: Read-only**.
- **Account permissions:** **Gists: Read and write**.

نفس التوكن تحطه في GitHub باسم `GIST_TOKEN` وفي Vercel باسم `GH_TOKEN`.

## 4. أسرار المستودع
Settings ← Secrets and variables ← Actions:

| النوع | الاسم | القيمة |
|---|---|---|
| Secret | `ALPACA_KEY` / `ALPACA_SECRET` | مفاتيح Alpaca (نفس اللي عندك) |
| Secret | `FINNHUB_KEY` | مفتاح Finnhub |
| Secret | `NTFY_TOPIC` | اسم موضوع ntfy جديد صعب التخمين |
| Secret | `GIST_ID` | من الخطوة 2 |
| Secret | `GIST_TOKEN` | من الخطوة 3 |
| Secret (اختياري) | `ANTHROPIC_API_KEY` | لتقرير المحلل المكتوب من Claude |
| Variable | `APP_URL` | رابط التطبيق على Vercel (بعد الخطوة 5) |

## 5. Vercel (الواجهة)
1. **Add New Project** ← استورد `smart-money`.
2. Environment Variables:
   - `GH_TOKEN` = توكن الخطوة 3
   - `GIST_ID` = من الخطوة 2
   - `GH_REPO` = `ameer90s/smart-money`
   - `APP_PIN` = رمز تختاره لفتح التطبيق
3. **Deploy**، ثم افتح الرابط وأدخل الرمز، وأضف التطبيق للشاشة الرئيسية.

## 6. التشغيل الأول (مرة وحدة)
Actions ← **engine** ← Run workflow ← `mode` = `maintenance`.
يبني الكون، ويفحص الأسهم شرعياً (يستغرق لين ساعة لأن Finnhub المجاني 60 طلب بالدقيقة)، ويشغّل الاختبار التاريخي لآخر 20 جلسة. بعدها يصير النموذج جاهز يعطي نسب الثقة.

## 7. التشغيل اليومي بالوقت (cron-job.org)
1. توكن ثاني Fine-grained باسم `smart-money-trigger`: Only select ← `smart-money` ← **Actions: Read and write**.
2. في cron-job.org أنشئ مهمة:
   - **URL:** `https://api.github.com/repos/ameer90s/smart-money/actions/workflows/engine.yml/dispatches`
   - **الوقت:** 11:45 UTC، من الاثنين للجمعة (= 15:45 الإمارات). يبدأ قبل الافتتاح بوقت كافي صيفاً وشتاءً.
   - **Method:** POST
   - **Headers:** `Authorization: Bearer <توكن الخطوة 1>`، و`Accept: application/vnd.github+json`، و`Content-Type: application/json`
   - **Body:** `{"ref":"main","inputs":{"mode":"auto"}}`
3. **Test run** لازم يرجع 204.

المحرك يشتغل لين 16:45 نيويورك. لما يوصل حد الـ 6 ساعات في GitHub يشغّل نسخة ثانية تكمل بنفسه.

**احتياط:** في الملف 5 كرونات GitHub (07:13، 08:13، 09:13، 10:13، 12:13 UTC) لو تعطل cron-job.org يوم. أول واحد يوصل يشغّل المحرك، والباقي ينتظر أو يتلغى. لو شفت في Actions تشغيلات «Cancelled» أو تشغيل ينتهي خلال ثواني بعد الإغلاق، هذا طبيعي.

## 8. التنبيهات
ثبّت تطبيق **ntfy** واشترك بنفس `NTFY_TOPIC`. من الإعدادات في التطبيق اضغط «إرسال تنبيه تجريبي».

## لاحقاً: سيرفر دائم (Oracle Always Free)
إذا تأخرت GitHub، انقل المحرك بدون تعديل كود:
```bash
curl -fsSL https://raw.githubusercontent.com/ameer90s/smart-money/main/deploy/install-oracle.sh | bash -s ameer90s/smart-money
sudo nano /etc/smart-money.env   # عبّي المفاتيح
sudo systemctl restart smart-money
```
بعدها عطّل التشغيل الخارجي في cron-job.org عشان ما يشتغل المحرك في مكانين.
