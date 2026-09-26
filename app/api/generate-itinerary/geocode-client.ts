// geocode-client.ts
// אימות מיקומים בצד לקוח - מחליף את verifyAllLocations בשרת.
// Nominatim פתוח לבקשות מהדפדפן (CORS) וחינמי לגמרי, בלי מפתח.
// התור מצמצם לבקשה אחת לשנייה כפי שמדיניות השימוש ההוגן דורשת.

const queue: (() => Promise<void>)[] = [];
let running = false;
let lastRequest = 0;

const MIN_INTERVAL_MS = 1100;

async function processQueue() {
  if (running) return;
  running = true;
  while (queue.length > 0) {
    const wait = Math.max(0, MIN_INTERVAL_MS - (Date.now() - lastRequest));
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastRequest = Date.now();
    const job = queue.shift()!;
    try {
      await job();
    } catch (e) {
      // נקודה שלא אומתה פשוט נשארת עם הקואורדינטות המקוריות
    }
  }
  running = false;
}

export function geocodeActivity(
  act: any,
  destination: string,
  onResult: (lat: number, lng: number) => void
) {
  queue.push(async () => {
    // שולפים את השם האנגלי/הלועזי מתוך הסוגריים - יש סיכוי גבוה יותר להתאמה מדויקת
    const englishMatch = act.name?.match(/\(([^)]+)\)\s*$/);
    const searchName = englishMatch ? englishMatch[1] : act.name;
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(
      `${searchName}, ${destination}`
    )}`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
      const results = await res.json();
      if (Array.isArray(results) && results.length > 0) {
        onResult(parseFloat(results[0].lat), parseFloat(results[0].lon));
      }
    } catch (e) {}
  });
  processQueue();
}

// === שימוש (בקומפוננטה שלך, אחרי שקיבלת את התוכנית מהשרת) ===
// const [plan, setPlan] = useState<any>(null);
//
// const handlePlan = (parsedJson: any) => {
//   parsedJson.days.forEach((day: any) =>
//     day.activities?.forEach((act: any) => {
//       geocodeActivity(act, parsedJson.destination, (lat, lng) => {
//         act.lat = lat;
//         act.lng = lng;
//         act.verifiedLocation = true;
//         // עדכון state כדי שהמפה תתרנדר מחדש עם הנקודות המדויקות
//         setPlan({ ...parsedJson });
//       });
//     })
//   );
//   setPlan(parsedJson);
// };