// constants/dtc_dictionary.ts
//
// Central dictionary of OBD-II Diagnostic Trouble Codes used across the
// Diagnostics screen. Each record carries a bilingual description, an
// urgency/"driving state" classification, and an advice script whose FIRST
// entry is always the immediate on-road guidance (what to do right now,
// behind the wheel) followed by the numbered technical repair steps.

export type UrgencyLevel = 'STOP' | 'REDUCE_SPEED' | 'CAUTION';

export interface DTCRecord {
  code: string;
  descEn: string;
  descAr: string;
  urgency: UrgencyLevel;
  // adviceEn[0] / adviceAr[0] = immediate driving guidance (shown first, styled distinctly).
  // adviceEn[1:] / adviceAr[1:] = numbered technical / workshop steps.
  adviceEn: string[];
  adviceAr: string[];
  // Responsible ECU/module (e.g. "Engine Control Module", "Transmission Control Module").
  // Optional because the curated local entries below don't always need it spelled out,
  // but AI-resolved codes always populate it.
  module?: string;
}

// Shared copy for each urgency tier — used to render badges/banners consistently.
export const URGENCY_META: Record<
  UrgencyLevel,
  { labelEn: string; labelAr: string; icon: string; color: 'danger' | 'warning' | 'accent' }
> = {
  STOP: {
    labelEn: 'Stop Immediately',
    labelAr: 'أوقف السيارة فوراً',
    icon: 'alert-circle',
    color: 'danger',
  },
  REDUCE_SPEED: {
    labelEn: 'Reduce Speed',
    labelAr: 'قلل السرعة',
    icon: 'speedometer-outline',
    color: 'warning',
  },
  CAUTION: {
    labelEn: 'Drive with Caution',
    labelAr: 'أكمل الطريق بحذر',
    icon: 'warning-outline',
    color: 'accent',
  },
};

export const DTC_DATABASE: Record<string, DTCRecord> = {
  P0300: {
    code: 'P0300',
    descEn: 'Random / Multiple Cylinder Misfire Detected',
    descAr: 'تفتيش عشوائي في أكثر من سلندر',
    urgency: 'REDUCE_SPEED',
    adviceEn: [
      'Ease off the accelerator now, avoid hard acceleration, and get to a safe stop as soon as possible — a sustained misfire can damage the catalytic converter.',
      'Check the engine bay for a flashing Check Engine light; if it flashes, stop the engine immediately.',
      'Inspect ignition coils and spark plug wires for wear, cracking, or a loose connection.',
      'Replace worn spark plugs and re-test with a fresh OBD-II scan.',
      'If the misfire persists, have fuel injectors and compression tested at a workshop.',
    ],
    adviceAr: [
      'ارفع رجلك عن دواسة البنزين تدريجياً، وتجنب الدعس المفاجئ، وحاول التوقف بأمان في أقرب وقت — التفتيش المستمر ممكن يتلف الكاتاليزر.',
      'راقب لمبة المحرك، لو بدأت ترمش بسرعة قف فوراً وأطفئ الموتور.',
      'افحص كويلات الشرارة (البوبينة) وأسلاك البواجي من التآكل أو الفك.',
      'غيّر البواجي المستهلكة وأعد الفحص بجهاز OBD-II.',
      'لو التفتيش مستمر، اعمل فحص انضغاط وحقن للسلندرات في الورشة.',
    ],
  },
  P0301: {
    code: 'P0301',
    descEn: 'Cylinder 1 Misfire Detected',
    descAr: 'تفتيش في السلندر رقم 1',
    urgency: 'REDUCE_SPEED',
    adviceEn: [
      'Reduce speed and avoid heavy load on the engine (hills, overtaking); head to a service point rather than continuing a long trip.',
      'Swap the coil/plug of cylinder 1 with another cylinder to isolate the fault.',
      'Inspect the spark plug for fouling, gap, or cracking.',
      'Check the fuel injector connector for cylinder 1.',
      'Clear the code and re-scan to confirm the misfire follows the swapped part.',
    ],
    adviceAr: [
      'قلل السرعة وابعد عن أي حمل زيادة على الموتور (طلعات أو سبق)، وتوجه لأقرب مركز صيانة بدل ما تكمل مشوار طويل.',
      'بدّل كويل وبوجيه السلندر رقم 1 مع سلندر تاني عشان تعرف مصدر العطل.',
      'افحص البوجيه من الاتساخ أو الفتحة أو الشرخ.',
      'راجع وصلة الحقان بتاعة السلندر رقم 1.',
      'امسح الكود وأعد الفحص عشان تتأكد إن العطل اتنقل مع القطعة اللي بدلتها.',
    ],
  },
  P0302: {
    code: 'P0302',
    descEn: 'Cylinder 2 Misfire Detected',
    descAr: 'تفتيش في السلندر رقم 2',
    urgency: 'REDUCE_SPEED',
    adviceEn: [
      'Drive gently, avoid full throttle, and plan to stop for inspection soon rather than continuing at highway speed.',
      'Swap the coil/plug of cylinder 2 with another cylinder to isolate the fault.',
      'Check compression on cylinder 2 if the misfire continues after parts are swapped.',
      'Inspect vacuum lines near cylinder 2 for leaks.',
      'Clear the code and confirm the fix with a fresh scan.',
    ],
    adviceAr: [
      'سوق بهدوء، ابعد عن الدعس الكامل، وخطط للتوقف والفحص قريب بدل الاستمرار بسرعة عالية على الطريق السريع.',
      'بدّل كويل وبوجيه السلندر رقم 2 مع سلندر تاني لعزل العطل.',
      'اعمل فحص انضغاط للسلندر رقم 2 لو التفتيش استمر بعد تبديل القطع.',
      'افحص خراطيم الفاكيوم حوالين السلندر رقم 2 من أي تسريب.',
      'امسح الكود وتأكد من الإصلاح بفحص جديد.',
    ],
  },
  P0303: {
    code: 'P0303',
    descEn: 'Cylinder 3 Misfire Detected',
    descAr: 'تفتيش في السلندر رقم 3',
    urgency: 'REDUCE_SPEED',
    adviceEn: [
      'Keep engine load light — no towing, no fast overtaking — until the cause is checked.',
      'Swap the coil/plug of cylinder 3 with another cylinder to isolate the fault.',
      'Check the spark plug gap and condition for cylinder 3.',
      'Inspect the fuel injector wiring for cylinder 3.',
      'Re-scan after repair to confirm the code has cleared.',
    ],
    adviceAr: [
      'خلي الحمل على الموتور خفيف — من غير جر أو سبق سريع — لحد ما تفحص السبب.',
      'بدّل كويل وبوجيه السلندر رقم 3 مع سلندر تاني لعزل العطل.',
      'افحص فتحة وحالة بوجيه السلندر رقم 3.',
      'افحص أسلاك الحقان الخاصة بالسلندر رقم 3.',
      'أعد الفحص بعد الإصلاح للتأكد إن الكود اتمسح.',
    ],
  },
  P0171: {
    code: 'P0171',
    descEn: 'System Too Lean (Bank 1)',
    descAr: 'خليط وقود فقير (بنك 1)',
    urgency: 'CAUTION',
    adviceEn: [
      'You can continue driving carefully; avoid hard acceleration and watch for rough idle or hesitation.',
      'Inspect for a vacuum or intake air leak around hoses and the intake manifold gasket.',
      'Check the MAF sensor for dirt or damage and clean it if needed.',
      'Inspect the fuel pump pressure and fuel filter.',
      'Clear the code and monitor short/long-term fuel trims after the fix.',
    ],
    adviceAr: [
      'تقدر تكمل السواقة بحذر؛ تجنب الدعس المفاجئ وراقب أي تذبذب أو تهنيج في الرغي.',
      'افحص أي تسريب هواء في خراطيم السحب أو جوان مانيفولد السحب.',
      'افحص حساس الهواء MAF من الاتساخ أو التلف ونضفه لو محتاج.',
      'افحص ضغط طرمبة البنزين وفلتر البنزين.',
      'امسح الكود وراقب ضبط الوقود (Fuel Trim) بعد الإصلاح.',
    ],
  },
  P0172: {
    code: 'P0172',
    descEn: 'System Too Rich (Bank 1)',
    descAr: 'خليط وقود غني (بنك 1)',
    urgency: 'CAUTION',
    adviceEn: [
      'Continue driving with caution; avoid short heavy-throttle bursts and note any smell of fuel or black exhaust smoke.',
      'Check the O2 sensor readings and replace if stuck rich.',
      'Inspect the fuel pressure regulator for a stuck-open condition.',
      'Check the air filter for clogging, which can trick the mixture rich.',
      'Clear the code and re-verify fuel trims after repair.',
    ],
    adviceAr: [
      'كمل السواقة بحذر؛ ابعد عن الدعس القوي المتقطع وراقب ريحة بنزين أو دخان أسود من العادم.',
      'افحص قراءة حساس الأكسجين وغيّره لو ثابت على قراءة غنية.',
      'افحص منظم ضغط البنزين من احتمال إنه فاضل مفتوح.',
      'افحص فلتر الهواء من الانسداد لأنه ممكن يخلي الخليط غني.',
      'امسح الكود وتأكد من ضبط الوقود بعد الإصلاح.',
    ],
  },
  P0420: {
    code: 'P0420',
    descEn: 'Catalyst System Efficiency Below Threshold (Bank 1)',
    descAr: 'كفاءة الكاتاليزر أقل من الحد المطلوب (بنك 1)',
    urgency: 'CAUTION',
    adviceEn: [
      'Safe to keep driving; the car will pass emissions less efficiently but there is no immediate mechanical risk.',
      'Rule out an upstream misfire or fuel-trim fault first, since these damage the catalyst over time.',
      'Inspect the catalytic converter for physical damage or rattling.',
      'Check upstream and downstream O2 sensors for correct switching behavior.',
      'Replace the catalytic converter only after confirming no upstream cause remains.',
    ],
    adviceAr: [
      'تقدر تكمل السواقة عادي؛ السيارة هتجتاز فحص الانبعاثات بكفاءة أقل بس مفيش خطر ميكانيكي فوري.',
      'استبعد الأول أي تفتيش أو مشكلة في ضبط الوقود لأنها بتتلف الكاتاليزر مع الوقت.',
      'افحص الكاتاليزر من أي تلف أو صوت خشخشة.',
      'افحص حساسات الأكسجين قبل وبعد الكاتاليزر من التبديل الصحيح للقراءة.',
      'غيّر الكاتاليزر بس بعد ما تتأكد إنه مفيش سبب تاني وراه.',
    ],
  },
  P0128: {
    code: 'P0128',
    descEn: 'Coolant Thermostat Below Regulating Temperature',
    descAr: 'الثرموستات ما بيوصلش لدرجة الحرارة المطلوبة',
    urgency: 'CAUTION',
    adviceEn: [
      'No immediate danger — continue driving, but expect weaker heater output and slightly higher fuel use until fixed.',
      'Check the coolant level and top up if low.',
      'Inspect the thermostat for sticking open.',
      'Replace the thermostat if the engine never reaches normal operating temperature.',
      'Re-scan after the fix to confirm normal warm-up behavior.',
    ],
    adviceAr: [
      'مفيش خطر فوري — كمل السواقة، بس متوقع ضعف في التدفئة واستهلاك بنزين أعلى شوية لحد ما تصلحها.',
      'افحص مستوى المياه في الرادياتير وكمّل لو ناقص.',
      'افحص الثرموستات من احتمال إنه عالق مفتوح.',
      'غيّر الثرموستات لو الموتور مبيوصلش لدرجة حرارة التشغيل الطبيعية.',
      'أعد الفحص بعد الإصلاح للتأكد إن السخونة بقت طبيعية.',
    ],
  },
  P0442: {
    code: 'P0442',
    descEn: 'EVAP Emission Control System Leak Detected (Small Leak)',
    descAr: 'تسريب صغير في نظام التبخر (EVAP)',
    urgency: 'CAUTION',
    adviceEn: [
      'Completely safe to keep driving; this is an emissions-only fault with no effect on engine performance.',
      'Check that the fuel cap is fully tightened — this is the most common cause.',
      'Inspect EVAP hoses for cracks or loose fittings.',
      'Check the purge and vent valves for proper operation.',
      'Clear the code; it may take a few drive cycles to confirm the fix.',
    ],
    adviceAr: [
      'آمن تماماً إنك تكمل السواقة؛ العطل ده خاص بالانبعاثات بس ومفيش تأثير على أداء الموتور.',
      'اتأكد إن غطاء تنك البنزين مقفول كويس — ده أشهر سبب للعطل ده.',
      'افحص خراطيم نظام EVAP من أي شرخ أو فك.',
      'افحص صمامات التنفيس والتفريغ من شغلها الصحيح.',
      'امسح الكود؛ ممكن ياخد كذا دورة تشغيل عشان يتأكد إن الإصلاح تمام.',
    ],
  },
  P0455: {
    code: 'P0455',
    descEn: 'EVAP Emission Control System Leak Detected (Large Leak)',
    descAr: 'تسريب كبير في نظام التبخر (EVAP)',
    urgency: 'CAUTION',
    adviceEn: [
      'Safe to keep driving; check for a fuel smell and inspect the fuel cap at your next stop.',
      'Verify the fuel cap is present, undamaged, and clicks fully closed.',
      'Inspect the filler neck and EVAP canister hoses for a disconnected or split section.',
      'Have a smoke test done at a workshop to pinpoint the leak location.',
      'Clear the code after repair and allow a full drive cycle to confirm.',
    ],
    adviceAr: [
      'تقدر تكمل السواقة بأمان؛ راقب أي ريحة بنزين وافحص غطاء التنك في أول وقفة.',
      'اتأكد إن غطاء التنك موجود وسليم ومقفول كويس لحد ما يعمل صوت طقة.',
      'افحص رقبة التعبئة وخراطيم كانستر EVAP من أي جزء مفكوك أو مشروخ.',
      'اعمل اختبار دخان (Smoke Test) في الورشة لتحديد مكان التسريب بالظبط.',
      'امسح الكود بعد الإصلاح واسيب دورة تشغيل كاملة للتأكيد.',
    ],
  },
  P0217: {
    code: 'P0217',
    descEn: 'Engine Overheat Condition',
    descAr: 'ارتفاع خطير في حرارة المحرك',
    urgency: 'STOP',
    adviceEn: [
      'Pull over safely right now, shut the engine off, and do NOT open the radiator cap while hot — continuing to drive risks severe engine damage.',
      'Wait at least 20–30 minutes for the engine to cool before checking anything under the hood.',
      'Check the coolant level once cool and inspect for visible leaks or a burst hose.',
      'Check the radiator fan and water pump for failure.',
      'Have the vehicle towed to a workshop if the temperature rises again after restarting.',
    ],
    adviceAr: [
      'قف على جنب فوراً، أطفئ الموتور، ولا تفتح غطاء الرادياتير وهو سخن — الاستمرار في السواقة ممكن يتلف الموتور بشكل خطير.',
      'استنى 20-30 دقيقة على الأقل عشان الموتور يبرد قبل ما تفتح الكبوت.',
      'اتأكد من مستوى المياه لما يبرد وافحص أي تسريب أو خرطوم مفجور.',
      'افحص مروحة الرادياتير وطرمبة المياه من احتمال العطل.',
      'اسحب العربية على ورشة لو الحرارة رجعت ترتفع بعد التشغيل.',
    ],
  },
  P0562: {
    code: 'P0562',
    descEn: 'System Voltage Low',
    descAr: 'انخفاض جهد النظام الكهربائي',
    urgency: 'CAUTION',
    adviceEn: [
      'Turn off non-essential electronics (AC, infotainment, extra lights) to reduce load, and drive to a safe location.',
      'Check the alternator belt for looseness or damage.',
      'Test the battery terminals for corrosion or a loose connection.',
      'Have the alternator output tested at a workshop.',
      'Replace the battery if it fails a load test.',
    ],
    adviceAr: [
      'اقفل الأجهزة الكهربائية اللي مش ضرورية (تكييف، شاشة، لمبات إضافية) عشان تقلل الحمل، وسوق لمكان آمن.',
      'افحص سير الدينامو من الرخاوة أو التلف.',
      'افحص أطراف البطارية من الصدأ أو الفك.',
      'اعمل اختبار لخرج الدينامو في الورشة.',
      'غيّر البطارية لو فشلت في اختبار الحمل.',
    ],
  },
  P0113: {
    code: 'P0113',
    descEn: 'Intake Air Temperature Sensor Circuit High Input',
    descAr: 'قراءة عالية في حساس حرارة هواء السحب',
    urgency: 'CAUTION',
    adviceEn: [
      'Safe to continue driving normally; performance impact is minimal.',
      'Inspect the IAT sensor connector for a poor connection.',
      'Check the sensor wiring for damage near the intake tract.',
      'Clean or replace the IAT sensor if it reads incorrectly.',
      'Clear the code and confirm the reading matches ambient temperature.',
    ],
    adviceAr: [
      'آمن إنك تكمل السواقة عادي؛ التأثير على الأداء بسيط جداً.',
      'افحص وصلة حساس حرارة الهواء من أي اتصال ضعيف.',
      'افحص أسلاك الحساس من أي تلف قريب من مسار السحب.',
      'نضّف أو غيّر الحساس لو قراءته غلط.',
      'امسح الكود وتأكد إن القراءة قريبة من حرارة الجو.',
    ],
  },
  P0135: {
    code: 'P0135',
    descEn: 'O2 Sensor Heater Circuit Malfunction (Bank 1, Sensor 1)',
    descAr: 'عطل في دائرة تسخين حساس الأكسجين (بنك 1، حساس 1)',
    urgency: 'CAUTION',
    adviceEn: [
      'Safe to keep driving; expect slightly higher fuel consumption until repaired.',
      'Check the O2 sensor heater fuse.',
      'Inspect the sensor wiring harness for damage or corrosion.',
      'Test heater circuit resistance against the manufacturer spec.',
      'Replace the O2 sensor if the heater circuit is confirmed open.',
    ],
    adviceAr: [
      'تقدر تكمل السواقة بأمان؛ توقع استهلاك بنزين أعلى شوية لحد ما تصلحها.',
      'افحص فيوز تسخين حساس الأكسجين.',
      'افحص ضفيرة أسلاك الحساس من التلف أو الصدأ.',
      'افحص مقاومة دائرة التسخين ومقارنتها بالمواصفة.',
      'غيّر حساس الأكسجين لو دائرة التسخين اتأكد إنها مقطوعة.',
    ],
  },
  P0700: {
    code: 'P0700',
    descEn: 'Transmission Control System Malfunction',
    descAr: 'عطل في نظام التحكم بناقل الحركة',
    urgency: 'STOP',
    adviceEn: [
      'If you feel harsh shifting, slipping, or the car gets stuck in one gear, pull over safely and stop — continuing risks transmission damage.',
      'Check the transmission fluid level and condition once parked safely.',
      'Scan the transmission control module for the underlying stored code, since P0700 only flags that a TCM fault exists.',
      'Inspect wiring connectors between the ECU and TCM.',
      'Have the vehicle towed if it will not shift out of limp mode.',
    ],
    adviceAr: [
      'لو حسيت بتعشيق خشن أو تزحلق أو العربية عالقة في ترس واحد، قف على جنب بأمان — الاستمرار ممكن يتلف الفتيس.',
      'افحص مستوى وحالة زيت الفتيس بعد ما توقف بأمان.',
      'اعمل فحص على وحدة تحكم الفتيس لمعرفة الكود الأصلي، لأن P0700 بس بيقول إن فيه عطل في الوحدة.',
      'افحص وصلات الأسلاك بين وحدة تحكم الموتور ووحدة الفتيس.',
      'اسحب العربية لو فضلت عالقة في الوضع الآمن (Limp Mode).',
    ],
  },
  P0088: {
    code: 'P0088',
    descEn: 'Fuel Rail/System Pressure Too High',
    descAr: 'ضغط رails البنزين مرتفع جداً',
    urgency: 'STOP',
    adviceEn: [
      'Stop the vehicle in a safe location as soon as possible — excessive fuel pressure can damage injectors or the fuel rail.',
      'Do not attempt to open any fuel line yourself; high pressure fuel systems can cause injury.',
      'Have the fuel pressure regulator inspected for a stuck-closed valve.',
      'Check the fuel pressure sensor reading against a manual gauge.',
      'Have the vehicle towed to a qualified workshop if the warning persists after restart.',
    ],
    adviceAr: [
      'وقّف العربية في مكان آمن بأسرع وقت — ضغط البنزين الزيادة ممكن يتلف الحاقنات أو الرايل.',
      'متحاولش تفتح أي خط بنزين بنفسك؛ نظام البنزين عالي الضغط ممكن يسبب إصابة.',
      'اطلب فحص منظم ضغط البنزين من احتمال إنه عالق مقفول.',
      'قارن قراءة حساس ضغط البنزين بجهاز قياس يدوي.',
      'اسحب العربية لورشة متخصصة لو التحذير فضل موجود بعد إعادة التشغيل.',
    ],
  },
};