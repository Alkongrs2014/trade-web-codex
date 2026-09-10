# =====================================================================
#  جدولة مهام المرصد في Task Scheduler.
#
#  لماذا PowerShell لا ملف .bat؟
#  cmd.exe يتتبّع موضعه في ملف الدفعة بالبايتات، ويعيد قراءة الموضع بعد
#  كل أمر. مع `chcp 65001` وملف UTF-8 فيه نص عربي طويل يختلّ هذا التتبّع
#  فتُقرأ الأوامر مقطّعة: جرّبناه فخرجت أخطاء مثل «'te' is not recognized»
#  و«'/SC' is not recognized» — نصفُ سطر schtasks يُنفَّذ كأمر مستقل.
#  الأسوأ أنه لا يفشل بوضوح: بعض المهام تُنشأ وبعضها لا، بلا رسالة تقول ذلك.
#  PowerShell يقرأ UTF-8 أصلاً فلا يعاني منه، وكنّا نحتاجه أصلاً لضبط
#  السقوف الزمنية. فصار مصدراً واحداً بدل ملفَّين يتباعدان.
#
#  الاستعمال:
#    powershell -ExecutionPolicy Bypass -File schedule.ps1            # بلا نشر
#    powershell -ExecutionPolicy Bypass -File schedule.ps1 -Publish   # مع النشر
#    (أو ببساطة: schedule.bat  /  schedule-publish.bat)
# =====================================================================
param([switch]$Publish)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$vbs  = Join-Path $root 'local\run-hidden.vbs'
if (-not (Test-Path $vbs)) { throw "لم يُعثر على $vbs" }

# الدورات الأربع. كل واحدة تجيب سؤالاً مختلفاً عن «كم يتغيّر هذا فعلاً»:
#   السعر يتغيّر كل لحظة · الشمعة المكتملة لا · سلسلة العقود أبطأ ·
#   أرقام الشركة تتغيّر مرة كل ربع سنة.
$tasks = @(
  @{ Name='WebTrade-Quotes';  Job='quotes';  Every=2;    LimitMin=5;   Desc='أسعار فقط' }
  @{ Name='WebTrade-Market';  Job='market';  Every=10;   LimitMin=20;  Desc='شمعات ومؤشرات وإشارات وأخبار' }
  @{ Name='WebTrade-Options'; Job='options'; Every=30;   LimitMin=25;  Desc='عقود الخيارات والجريكس' }
  # الأرشيف يجلب خمس سنوات لخمسمئة رمز، فسقفه ساعة لا نصف
  @{ Name='WebTrade-Daily';   Job='daily';   At='09:30'; LimitMin=60;  Desc='أساسيات وترتيب وأحداث وأرشيف' }
)

# بلا نشر: لا حاجة لدورة الأسعار السريعة، فهي موجودة أصلاً كي يبقى
# الموقع المنشور حديثاً. محلياً يكفي تحديث كل عشر دقائق.
if (-not $Publish) { $tasks = $tasks | Where-Object { $_.Name -ne 'WebTrade-Quotes' } }

Write-Host ""
Write-Host "  جدولة المرصد$(if ($Publish) {' — مع النشر التلقائي على GitHub'})" -ForegroundColor Cyan
Write-Host "  المجلد: $root"
Write-Host ""
foreach ($t in $tasks) {
  $when = if ($t.At) { "يومياً $($t.At)" } else { "كل $($t.Every) دقيقة" }
  Write-Host ("    {0,-18} {1,-16} {2}" -f $t.Name, $when, $t.Desc)
}
Write-Host ""
Write-Host "  المهام لا تتداخل: قفل في data يجعل المتأخّرة تنسحب، لأن دورتين"
Write-Host "  معاً تتجاوزان حصّة الطلبات فيبدأ المزوّد بالرفض."
if ($Publish) {
  Write-Host ""
  Write-Host "  يتطلب أن يكون المجلد مربوطاً بـ GitHub (local\link-github.bat)."
}
Write-Host ""
Read-Host "  اضغط Enter للمتابعة (أو Ctrl+C للإلغاء)" | Out-Null

# الإنشاء بـ schtasks.exe لا بـ Register-ScheduledTask: الأخيرة تحتاج
# RepetitionDuration للتكرار اللانهائي، و[TimeSpan]::MaxValue يخرج منها
# P99999999DT23H59M59S فيرفضه المجدول («قيمة خارج المدى»). schtasks
# تفهم /SC MINUTE /MO n مباشرة. ثم نضبط ما لا تعرفه schtasks عبر
# Set-ScheduledTask: السقف الزمني ومنع التداخل.
$failed = @()
foreach ($t in $tasks) {
  $jobArgs = if ($Publish) { "$($t.Job) --publish" } else { $t.Job }
  # wscript لا node مباشرة: node تطبيق كونسول، فيفتح Windows نافذة طرفية
  # مرئية مع كل تشغيل — أي كل دقيقتين مع دورة الأسعار.
  $tr = 'wscript.exe "' + $vbs + '" ' + $jobArgs
  $a = @('/Create', '/TN', $t.Name, '/TR', $tr, '/F')
  $a += if ($t.At) { @('/SC', 'DAILY', '/ST', $t.At) }
        else       { @('/SC', 'MINUTE', '/MO', "$($t.Every)") }

  $out = & schtasks.exe @a 2>&1
  if ($LASTEXITCODE -ne 0) {
    $failed += $t.Name
    Write-Host "    ✗ $($t.Name) — $out" -ForegroundColor Red
    continue
  }

  # IgnoreNew يعمل الآن فعلاً: run-hidden.vbs صار ينتظر node بدل أن
  # يخرج فوراً، فيرى المجدول التشغيل جارياً ويعرف أن يتخطّى الجديد.
  try {
    $task = Get-ScheduledTask -TaskName $t.Name
    $task.Settings.ExecutionTimeLimit = "PT$($t.LimitMin)M"
    $task.Settings.MultipleInstances  = 'IgnoreNew'
    $task.Settings.StartWhenAvailable = $true
    $task.Settings.DisallowStartIfOnBatteries = $false
    $task.Settings.StopIfGoingOnBatteries     = $false
    Set-ScheduledTask -TaskName $t.Name -Settings $task.Settings | Out-Null
    Write-Host "    ✓ $($t.Name)" -ForegroundColor Green
  } catch {
    # المهمة أُنشئت لكن إعداداتها لم تُضبط — ليست فشلاً تاماً، وقولها
    # أصدق من علامة ✓ تخفي نصف الحقيقة
    Write-Host "    ~ $($t.Name) — أُنشئت بلا ضبط السقف الزمني: $($_.Exception.Message)" -ForegroundColor Yellow
  }
}

Write-Host ""
if ($failed.Count) {
  Write-Host "  ✗ فشل إنشاء: $($failed -join '، ')" -ForegroundColor Red
  Write-Host "    جرّب فتح نافذة الأوامر كمسؤول وأعد التشغيل."
  Write-Host ""
}
Write-Host "  تم. للتحقّق:" -ForegroundColor Cyan
Write-Host "    Get-ScheduledTask -TaskName WebTrade-*"
Write-Host "  للإلغاء:"
foreach ($t in $tasks) { Write-Host "    schtasks /Delete /TN `"$($t.Name)`" /F" }
Write-Host ""
Read-Host "  اضغط Enter للإغلاق" | Out-Null
