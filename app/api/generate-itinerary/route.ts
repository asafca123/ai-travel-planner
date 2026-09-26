import { NextRequest, NextResponse } from "next/server";

export const runtime = 'edge';

// בחינם (Hobby) Vercel חותך את הפונקציה אחרי 10 שניות בכל מקרה -
// המספר כאן רלוונטי רק בחשבון בתשלום
export const maxDuration = 30;

let cachedModel: string = "";

async function getAvailableGroqModel(apiKey: string): Promise<string> {
  if (cachedModel !== "") return cachedModel;

  try {
    const res = await fetch("https://api.groq.com/openai/v1/models", {
      headers: { "Authorization": `Bearer ${apiKey}` }
    });
    
    if (res.ok) {
      const data = await res.json();
      const models = (data.data || []).map((m: any) => m.id);
      
      // סינון מדויק שמונע גישה למודלי אודיו, גארד או מודלים שאינם נתמכים במפתח
      const validModels = models.filter((id: string) => {
        const lower = id.toLowerCase();
        return !lower.includes("guard") &&
               !lower.includes("whisper") &&
               !lower.includes("audio") &&
               !lower.includes("embed") &&
               !lower.includes("vision") &&
               !lower.includes("canopy") &&
               !lower.includes("orpheus") &&
               !lower.includes("tts");
      });

      const preferred = validModels.find((id: string) => 
        id.includes("llama-3.3-70b") ||
        id.includes("llama-3.1-70b") ||
        id.includes("llama-3.1-8b-instant") ||
        id.includes("mixtral")
      );

      if (preferred) {
        cachedModel = preferred;
        return cachedModel;
      }

      if (validModels.length > 0) {
        cachedModel = validModels[0];
        return cachedModel;
      }
    }
  } catch (e) {}

  cachedModel = "llama-3.1-8b-instant";
  return cachedModel;
}

// === חדש: מנוע תיקון JSON חכם המבוסס על מעקב עומק סוגריים ומחרוזות ===
// בניגוד לרג'קסים הישנים, זה מטפל נכון בחיתוך אמיתי של הטוקסט (למשל
// באמצע מחרוזת או באמצע ערך), ע"י איתור נקודת החיתוך הבטוחה האחרונה
// (סוגר שנסגר בהצלחה, או פסיק בין איברים שלמים) וסגירת כל המבנים הפתוחים.
function smartCompleteJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch (e) {}

  const cleaned = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  const firstOpen = cleaned.indexOf("{");
  if (firstOpen === -1) throw new Error("No JSON object start found");
  const candidate = cleaned.substring(firstOpen);

  const stack: string[] = [];
  let inString = false;
  let escapeNext = false;
  let lastSafeIndex = -1;

  for (let i = 0; i < candidate.length; i++) {
    const ch = candidate[i];

    if (inString) {
      if (escapeNext) {
        escapeNext = false;
      } else if (ch === "\\") {
        escapeNext = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === "{" || ch === "[") {
      stack.push(ch);
    } else if (ch === "}" || ch === "]") {
      stack.pop();
      lastSafeIndex = i + 1; // a value/object/array just closed cleanly — safe cut point
    } else if (ch === "," && stack.length > 0) {
      lastSafeIndex = i; // a previous sibling value finished right before this comma
    }
  }

  if (lastSafeIndex === -1) {
    throw new Error("Could not find any safe truncation point in response");
  }

  const truncated = candidate.substring(0, lastSafeIndex);

  let closer = "";
  for (let i = stack.length - 1; i >= 0; i--) {
    closer += stack[i] === "{" ? "}" : "]";
  }

  return JSON.parse(truncated + closer);
}

// מנוע פענוח ותיקון JSON חסין לחלוטין (מטפל בחיתוכי טוקנים, פסיקים ומבנים שבורים)
function robustJsonParse(text: string) {
  let cleaned = text.replace(/```json/gi, "").replace(/```/g, "").trim();

  try {
    return JSON.parse(cleaned);
  } catch (e) {}

  // חדש: ניסיון תיקון מודע-מבנה לפני הרג'קסים הישנים — הרבה יותר אמין
  // עבור תשובות שנחתכו אמצע (finish_reason: "length").
  try {
    return smartCompleteJson(cleaned);
  } catch (eSmart) {}

  let firstOpen = cleaned.indexOf('{');
  if (firstOpen !== -1) {
    let jsonCandidate = cleaned.substring(firstOpen);

    let attempts = [
      jsonCandidate,
      jsonCandidate + '}',
      jsonCandidate + ']}',
      jsonCandidate + '"]}',
      jsonCandidate + '}]}'
    ];

    for (let candidate of attempts) {
      try {
        let repaired = candidate
          .replace(/[\u0000-\u001F]+/g, " ")
          .replace(/,\s*([\]}])/g, "$1")
          .replace(/([}\"])\s*([{\"])/g, "$1,$2")
          .replace(/([0-9truefalseull\]\)])\s*([{\["])/g, "$1,$2")
          .replace(/\n/g, " ");

        return JSON.parse(repaired);
      } catch (err) {}
    }

    try {
      let lastClose = jsonCandidate.lastIndexOf('}');
      if (lastClose !== -1) {
        let trimmed = jsonCandidate.substring(0, lastClose + 1);
        const evaluated = (new Function(`return ${trimmed}`))();
        if (evaluated && typeof evaluated === 'object') {
          return evaluated;
        }
      }
    } catch (e4) {}
  }

  throw new Error("No valid JSON structure could be recovered from response");
}

// === חדש: תקציב טוקנים דינמי לפי מספר הימים ===
// עברית צורכת בממוצע פי 2-3 טוקנים לעומת אנגלית עבור אותו תוכן, ולכל
// פעילות יש כמה שדות (time/name/description/category/lat/lng/ticketLink),
// אז 8192 טוקנים קבועים לא מספיקים לטיולים ארוכים. llama-3.3-70b-versatile
// תומך עד 32,768 טוקני פלט - אז מנצלים את זה בהתאם לאורך הטיול והניסיון.
function computeMaxTokens(numDays: number, attempt: number): number {
  const HARD_CAP = 6000;
  const baseTokens = 1000;
  const perDayTokens = 400;
  let budget = baseTokens + numDays * perDayTokens;

  // בכל ניסיון חוזר (במקרה של חיתוך) מגדילים את התקציב משמעותית
  if (attempt >= 2) budget = Math.max(budget, budget * 1.6);

  return Math.min(HARD_CAP, Math.round(budget));
}

// === חדש: קאש קטן ב-Upstash Redis (חינמי, ללא כרטיס אשראי) ===
// מטרת הקאש: לא לבזבז מכסת חיפושים אמיתית (Serper) על אותו יעד+סגנון
// פעמיים. אם אין UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN
// מוגדרים, שתי הפונקציות פשוט לא עושות כלום ומחזירות null/undefined -
// המערכת ממשיכה לעבוד כרגיל, רק בלי החיסכון הזה.
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

async function cacheGet(key: string): Promise<string | null> {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return null;
  try {
    const res = await fetch(`${UPSTASH_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }
    });
    if (!res.ok) return null;
    const data = await res.json();
    return typeof data.result === "string" ? data.result : null;
  } catch (e) {
    return null;
  }
}

async function cacheSet(key: string, value: string, ttlSeconds: number): Promise<void> {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return;
  try {
    await fetch(UPSTASH_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${UPSTASH_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(["SET", key, value, "EX", String(ttlSeconds)])
    });
  } catch (e) {}
}

// === חדש: חיפוש אינטרנט אמיתי (Serper.dev) לקרקוע העובדות ===
// המודל עצמו לא "יודע" לגלוש - הוא מנחש מהזיכרון שלו, וזה בדיוק למה
// הוא מפספס דברים ספציפיים כמו מסלולי טיפוס בקלימנוס. הפונקציה הזו
// מביאה תוצאות חיפוש אמיתיות ומזינה אותן חזרה לפרומפט כחומר מקור.
// דורש מפתח SERPER_API_KEY (נרשמים באימייל בלבד ב-serper.dev - ללא
// כרטיס אשראי, 2,500 חיפושים חינם). אם אין מפתח, הפונקציה מחזירה
// מחרוזת ריקה והמערכת ממשיכה כרגיל בלעדיה - לא קורסת ולא נעצרת.
async function searchWebForGrounding(query: string, apiKey: string): Promise<string> {
  try {
    const res = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: {
        "X-API-KEY": apiKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ q: query, num: 8 })
    });

    if (!res.ok) return "";

    const data = await res.json();
    const organic = Array.isArray(data.organic) ? data.organic : [];

    if (organic.length === 0) return "";

    return organic
      .slice(0, 8)
      .map((r: any, i: number) => `${i + 1}. ${r.title || ""} — ${r.snippet || ""}`)
      .join("\n");
  } catch (e) {
    return "";
  }
}

// === עודכן: אימות מיקום מול Nominatim (OpenStreetMap) במקום Google ===
// Google Geocoding דורש חיוב בכרטיס אשראי גם לשימוש חינמי. Nominatim
// הוא מנוע geocoding חינמי ופתוח לגמרי - אין הרשמה, אין מפתח API,
// אין כרטיס אשראי בכלל. לעולם לא סומכים על קואורדינטות שה-AI המציא
// בעצמו (זו הסיבה שנקודות נופלות בים) - במקום זה שולפים את השם
// האנגלי/הלועזי מתוך הסוגריים (יש סיכוי גבוה יותר להתאמה מדויקת)
// ומחליפים את lat/lng בקואורדינטות האמיתיות שהשירות מחזיר.
// מדיניות השימוש ההוגן של Nominatim מבקשת מקסימום בקשה אחת בשנייה
// ו-User-Agent אמיתי שמזהה את האפליקציה - שני התנאים מיושמים למטה.
async function geocodePlace(
  name: string,
  destination: string
): Promise<{ lat: number; lng: number; displayName?: string } | null> {
  try {
    const englishMatch = name.match(/\(([^)]+)\)\s*$/);
    const searchName = englishMatch ? englishMatch[1] : name;
    const query = `${searchName}, ${destination}`;

    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(query)}`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(6000),
      headers: {
        // חובה לפי מדיניות השימוש של Nominatim - יש להחליף לשם האפליקציה
        // ואימייל אמיתי לפני שהאתר עולה בקנה מידה משמעותי
        "User-Agent": "AI-Travel-Planner/1.0 (contact: your-email@example.com)"
      }
    });
    if (!res.ok) return null;

    const results = await res.json();
    if (Array.isArray(results) && results.length > 0) {
      const lat = parseFloat(results[0].lat);
      const lng = parseFloat(results[0].lon);
      if (!Number.isNaN(lat) && !Number.isNaN(lng)) {
        return { lat, lng, displayName: results[0].display_name };
      }
    }
    return null;
  } catch (e) {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// === עודכן: מריצים אימות מיקומים על כל הפעילויות, בזה אחר זה ===
// (לא במקביל - Nominatim מבקש מקסימום בקשה אחת בשנייה בשימוש ההוגן שלו,
// אז יש כאן השהיה של כ-1.1 שניות בין כל בקשה). לצד זה יש תקציב זמן
// כולל לשלב הזה, כדי לא לחרוג ממגבלת ה-60 שניות של הפונקציה - אם
// טיול ארוך מאוד לא מספיק להיבדק במלואו בזמן, שאר הפעילויות פשוט
// נשארות עם הקואורדינטות שה-AI סיפק (ומסומנות כלא-מאומתות) במקום
// שהפונקציה כולה תיכשל.
const NOMINATIM_MIN_INTERVAL_MS = 1100;
const GEOCODE_TIME_BUDGET_MS = 40000;

async function verifyAllLocations(parsed: any, destination: string) {
  if (!parsed || !Array.isArray(parsed.days)) return;

  const startedAt = Date.now();

  for (const day of parsed.days) {
    if (!Array.isArray(day.activities)) continue;
    for (const act of day.activities) {
      if (!act.name) continue;

      if (Date.now() - startedAt > GEOCODE_TIME_BUDGET_MS) {
        if (act.verifiedLocation === undefined) act.verifiedLocation = false;
        continue;
      }

      const geo = await geocodePlace(act.name, destination);
      if (geo) {
        act.lat = geo.lat;
        act.lng = geo.lng;
        act.verifiedLocation = true;
      } else {
        act.verifiedLocation = false;
      }

      await sleep(NOMINATIM_MIN_INTERVAL_MS);
    }
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null);
    if (!body) {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const { destination, startPoint, startDate, days, travelStyle, customPlaces, language = "he" } = body;

    if (!destination || !days || !travelStyle) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }

    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: "GROQ_API_KEY is missing in .env.local" }, { status: 500 });
    }

    const modelName = await getAvailableGroqModel(apiKey);

    // === חדש: מודל מהיר לטיולים ארוכים (הכרחי בחינם של Vercel) ===
    // ב-Hobby יש רק 10 שניות לפונקציה. llama-3.3-70b מייצר ~300 טוקנים/שנייה,
    // ולכן מסלול של 5+ ימים עלול לחרוג מהזמן. llama-3.1-8b-instant פי 2-3
    // יותר מהיר - מספיק לטיולים ארוכים, גם אם האיכות קצת נמוכה יותר.
    let finalModel = "llama-3.3-70b-versatile";
    try {
      const modelsRes = await fetch("https://api.groq.com/openai/v1/models", {
        headers: { "Authorization": `Bearer ${apiKey}` }
      });
      if (modelsRes.ok) {
        const modelsData = await modelsRes.json();
        const availableIds: string[] = (modelsData.data || []).map((m: any) => m.id);
        const allowedPrefixes = ["llama", "mixtral", "gemma", "qwen", "deepseek", "moonshot"];
        const safeChatModels = availableIds.filter((id: string) => {
          const lower = id.toLowerCase();
          const isKnownChat = allowedPrefixes.some(prefix => lower.includes(prefix));
          const isForbidden = lower.includes("guard") || lower.includes("whisper") || 
                              lower.includes("tts") || lower.includes("orpheus") ||
                              lower.includes("canopy") || lower.includes("audio") ||
                              lower.includes("embed") || lower.includes("vision");
          return isKnownChat && !isForbidden;
        });
        console.log("[DEBUG] מודלים מאושרים:", safeChatModels);
        if (safeChatModels.length > 0) {
          const preferred70b = safeChatModels.find((id: string) => id.includes("3.3-70b-versatile"));
          const fastCandidate = safeChatModels.find((id: string) => 
            id.includes("8b-instant") || id.includes("8b-8192") || id.includes("gemma2-9b")
          );
          finalModel = preferred70b || fastCandidate || safeChatModels[0];
        }
        console.log("[DEBUG] נבחר מודל:", finalModel);
      }
    } catch (e) {}

    const isFastModel = finalModel.includes("8b") || finalModel.includes("9b");

    // === חדש: חיפוש קרקוע אמיתי לפי יעד + סגנון טיול ===
    // עודכן: קודם בודקים קאש (Upstash) לפי מפתח יעד+סגנון מנורמל.
    // רק אם אין תוצאה שמורה, עושים חיפוש אמיתי (Serper) ושומרים אותו
    // ל-30 יום - כך שכל בקשה חוזרת לאותו יעד+סגנון לא צורכת מכסה נוספת.
    // אם אין SERPER_API_KEY, webContext יישאר ריק והמערכת ממשיכה כרגיל.
    const serperApiKey = process.env.SERPER_API_KEY;
    let webContext = "";
    if (serperApiKey) {
      const normalizedDestination = String(destination).trim().toLowerCase();
      const normalizedStyle = String(travelStyle).trim().toLowerCase();
      const searchCacheKey = `search-grounding:${normalizedDestination}:${normalizedStyle}`;

      const cachedContext = await cacheGet(searchCacheKey);
      if (cachedContext !== null) {
        webContext = cachedContext;
      } else {
        // >>> ספורט: שאילתת חיפוש מותאמת לסגנון ספורטיבי
        const isSportsStyle = travelStyle.toLowerCase().includes("sport") || travelStyle.toLowerCase().includes("ספורט");
        const groundingQuery = isSportsStyle
          ? `${destination} professional sports games schedule fixtures 2026 ${startDate || ""} top league football basketball tennis local matches tickets`
          : `${destination} ${travelStyle} specific real named spots routes trails 2026 guide`;
        webContext = await searchWebForGrounding(groundingQuery, serperApiKey);
        if (webContext) {
          // 30 יום - מסלולי טיפוס, שבילים ואתרי טבע לא משתנים בטווח הזמן הזה
          await cacheSet(searchCacheKey, webContext, 60 * 60 * 24 * 30);
        }
      }
    }

    let parsedJson = null;
    let attempt = 0;
    // ב-Vercel Hobby (חינם) יש מגבלה של 10 שניות לכל פונקציה - ניסיון אחד בלבד.
    // אם הניסיון נכשל, הלקוח מציג את כפתור "צור מסלול טיול" שולח בקשה חדשה.
    const MAX_ATTEMPTS = 1;
    let lastError = "";
    let lastWasTruncated = false;
    let rawResponseSnapshot = "";

    while (attempt < MAX_ATTEMPTS && !parsedJson) {
      attempt++;

      const numDays = Number(days) || 3;
      
      // === עודכן: משטר תוכן לטיולים ארוכים ===
      // בעבר הצמצום החד (2-3 פעילויות, תיאורים מתחת ל-10 מילים) היה נועד
      // לעקוף את בעיית חיתוך הטוקנים. עכשיו שתקציב הטוקנים מחושב נכון
      // ומספיק גם לטיולים ארוכים, אין צורך "לחסוך" למשתמש על חשבון
      // איכות המסלול - רק לטיולים ארוכים מאוד (10+ ימים) שומרים על מתינות קלה.
      const lengthConstraint = numDays >= 10
        ? "For very long trips (10+ days): generate exactly 3 activities per day, with short 1-sentence descriptions (max ~15 words) each, so ALL days fit inside the response. Vary phrasing; never loop or repeat the same activity text."
        : numDays >= 6
        ? "Generate 3-4 activities per day with concise 1-2 sentence descriptions, so all days fit."
        : "Provide diverse, rich, and detailed descriptions (2-3 sentences). Generate 3-5 activities per day.";

      // === חדש: בלוק קרקוע עובדתי מתוצאות חיפוש אמיתיות ===
      const webContextBlock = webContext
        ? `\nREAL-WORLD SEARCH RESULTS FOR THIS DESTINATION AND STYLE (treat this as your primary source of truth for anything specific - named routes, crags, trails, sectors, festivals, events, etc. Reference SPECIFIC real names found here instead of inventing generic ones. If a result is irrelevant, ignore it):\n${webContext}\n`
        : "";

      const systemPrompt = `You are an expert travel planner AI. Return ONLY a valid JSON object starting with '{' and ending with '}'. 
All JSON keys MUST be in English, but text values MUST be in fluent Israeli Hebrew.

User's Custom Places / Google Maps List to Integrate (PRIORITY ANCHORS):
"${customPlaces || "None provided"}"
${webContextBlock}
CRITICAL ANTI-HALLUCINATION & OPTIMIZATION RULES:
1. TYPO CORRECTION: If the user misspelled the destination (e.g. 'קלימנוש' instead of 'קלימנוס'), auto-correct it silently and plan for the real place.
2. EXACT GOOGLE MAPS LOCATIONS & NO CITY-CENTER DUMPING: Ensure 'lat' and 'lng' point precisely to the actual building, trail entrance, or beach on SOLID LAND. If you do not know the exact coordinates of a specific cliff or beach, DO NOT fallback to the "city center" or main port (this leads to hallucinations). Instead, fallback to the broader verifiable geographical feature on Google Maps (e.g., the specific National Park, nature reserve, or exact coastal strip). NEVER guess water coordinates! (Note: the server will still cross-check every coordinate against a real geocoding service afterward, but a precise, real place NAME here is what makes that cross-check succeed instead of falling back to something vague.)
3. DESTINATION DNA & EXTREME SPORTS: If 'extreme sports' is selected, analyze what the destination is actually famous for. For example, Kalymnos is for rock climbing (not surfing). Siargao is for surfing. Suggest ONLY the correct sport, use professional terminology, and link to professional sites (e.g., Mountain Project, Surfline). When the REAL-WORLD SEARCH RESULTS block above lists specific named routes, sectors, or crags, USE THOSE EXACT NAMES rather than a generic "go rock climbing" activity - name the actual sector/route (e.g., "Grande Grotta", "Odyssey", "Arhi") the way a specialized local guide would.
4. OBSCURE DESTINATIONS: If the destination is a small town, island, or off the beaten path, DO NOT INVENT generic museums or fake attractions. Rely strictly on real nature, geography, or authentic local life.
5. NO SPECIFIC RESTAURANT NAMES: To save tokens and avoid hallucinations, DO NOT provide specific restaurant names. Instead, suggest a *type* of dining in the area.
6. GEOGRAPHIC ANCHORING & COMMUTE: All activities MUST be within a realistic commute (max 1 hour).
7. SMART REPETITION: DO NOT repeat specific tours, museums, or landmarks. However, you MAY freely repeat visits to beautiful beaches, pools, or nature relaxation spots on different days.

CRITICAL RULES FOR BILINGUAL NAMES, TICKETS & EVENTS:
8. BILINGUAL NAMES & PROPER TRANSLITERATION: Every activity 'name' MUST include the Hebrew name and the official English/Local name in parentheses. CRITICAL: DO NOT literally translate proper nouns! Transliterate them (e.g., 'Southbank Centre' should be 'מרכז סאות'בנק'). Only translate generic words like Park, Museum, Beach. This applies to specific route/crag/trail names too (e.g., a climbing sector called "Odyssey" becomes "אודיסיאה (Odyssey)", never a literal Hebrew translation of the word).
9. BOOKING.COM LINK: Generate a specific URL in 'bookingLink' searching for the recommended neighborhood. Format: "https://www.booking.com/searchresults.html?ss=[Destination]+[Neighborhood]".
10. SPORTS & EVENTS — STRICT RULES (READ CAREFULLY):
   - If 'sports' style is selected, the user wants to ATTEND REAL PROFESSIONAL GAMES, not tours.
   - ALLOWED: Real scheduled matches in the country's TOP professional league (e.g., Premier League, La Liga, NBA, EuroLeague, ATP/WTA tennis, national team games, local derby).
   - FORBIDDEN: Stadium tours, museum visits of sports clubs, empty stadium walks, "experience the atmosphere of the stadium", generic "watch locals play".
   - If you KNOW a specific game happens during these dates (from the REAL-WORLD SEARCH RESULTS block above), use it with the exact team names and date.
   - If you do NOT know a specific game, suggest going to a real sports venue/arena where PROFESSIONAL games are regularly held (e.g., "Camp Nou", "Madison Square Garden", "Wimbledon Centre Court") and specify the type of game to look for. DO NOT invent fake game dates.
   - For tennis: suggest ATP/WTA tournaments or Grand Slam venues only.
   - For basketball: suggest NBA, EuroLeague, or the top local league.
   - NEVER suggest a stadium tour. If you cannot find a real game, do NOT use sports as the activity at all — pick a different real attraction instead.
   - ZERO HALLUCINATION: Do not invent game scores, specific player names, or fake fixtures.
11. TICKETS: For proven events or museums, provide an official website or a search link to buy tickets in the 'ticketLink' field. If not applicable, return an empty string "".
12. NATURAL, NON-ROBOTIC HEBREW: Write every 'description' the way an experienced Israeli travel writer would - fluent, idiomatic, and specific to that exact place. NEVER produce a literal word-for-word translation of generic English tourism phrasing (that is what reads as robotic). Vary sentence openings and structure across activities - do not start multiple descriptions with the same word or template phrase (e.g., don't begin every single description with "תיהנו מ..." או "בקרו ב..."). Use concrete, sensory, place-specific details rather than generic filler.

Required JSON Structure:
{
  "tripTitle": "...",
  "destination": "...",
  "summary": "...",
  "hotelRecommendation": "המלצה מפורטת על האזור או השכונה המומלצת ביותר במרכז העיר בהתאם לסגנון (ללא שמות מלונות ספציפיים, רק אזורים ושכונות).",
  "bookingLink": "https://www.booking.com/...",
  "days": [
    {
      "day": 1,
      "title": "...",
      "activities": [
        {
          "time": "09:00",
          "name": "Hebrew Name (English Name)",
          "description": "...",
          "category": "...",
          "lat": 31.0,
          "lng": 34.8,
          "ticketLink": "https://..."
        }
      ]
    }
  ]
}

Rules:
- Generate ALL requested days (Day 1 through Day ${days}) fully without skipping.
- High diversity, no repetition between days. Write in natural, engaging Hebrew.
- ${lengthConstraint}`;

      const userPrompt = `Destination: ${destination}\nStarting Point: ${startPoint || destination}\nStart Date: ${startDate || "N/A"}\nDays: ${days}\nTravel Style: ${travelStyle}`;

      // ל-llama-3.1-8b-instant יש תקרת פלט של 8192 טוקנים - לא מבקשים יותר כדי לא לקבל שגיאת 400
      const attemptMaxTokens = isFastModel
        ? Math.min(computeMaxTokens(numDays, attempt), 7000)
        : computeMaxTokens(numDays, attempt);

      try {
        const apiResponse = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiKey}`,
          },
          // הגנה מפני בקשה שנתקעת - אחרי 28 שניות מתבצע ביטול אוטומטי
          // (ב-Edge יש 30 שניות, אז 28 זה הזמן הבטוח)
          signal: AbortSignal.timeout(28000),
          body: JSON.stringify({
            model: finalModel,
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: userPrompt }
            ],
            temperature: 0.7, // חזרנו לטמפרטורה נורמלית כדי למנוע את הלולאות והחזרתיות של המקומות
            max_tokens: attemptMaxTokens,
            response_format: { type: "json_object" } // מכריח את Groq להחזיר JSON תקין
          }),
        });

        const responseText = await apiResponse.text();

        if (!apiResponse.ok) {
          let errMsg = responseText;
          try {
            const errJson = JSON.parse(responseText);
            errMsg = errJson?.error?.message || errMsg;
          } catch {}
          lastError = `Groq HTTP ${apiResponse.status}: ${errMsg}`;
          console.error(`[attempt ${attempt}]`, lastError);
          // אם זו rate-limit (429) או שגיאת שרת זמנית (5xx) - ממתינים לפני הניסיון הבא
          if (apiResponse.status === 429 || apiResponse.status >= 500) {
            await sleep(1500 * attempt);
          }
          continue;
        }

        const data = JSON.parse(responseText);
        const rawText = data.choices?.[0]?.message?.content;
        const finishReason = data.choices?.[0]?.finish_reason;
        lastWasTruncated = finishReason === "length";
        rawResponseSnapshot = rawText || "";

        if (!rawText) {
          lastError = "Model returned empty content.";
          console.error(`[attempt ${attempt}]`, lastError);
          continue;
        }

        // אם התשובה נחתכה (finish_reason=length), קודם מנסים לשחזר ממנה
        // ימים שלמים חלקיים - תוכנית חלקית טובה הרבה יותר ממסך שגיאה.
        // רק אם השחזור נכשל ועוד נשארו ניסיונות, מנסים שוב עם תקציב גדול יותר.
        if (lastWasTruncated) {
          try {
            const salvaged = robustJsonParse(rawText);
            if (salvaged && Array.isArray(salvaged.days) && salvaged.days.length > 0) {
              parsedJson = salvaged;
              console.warn(`[attempt ${attempt}] Response truncated but recovered ${salvaged.days.length} day(s).`);
            }
          } catch (salvageErr) {
            // השחזור נכשל - ממשיכים לניסיון הבא עם תקציב גדול יותר
          }
        }

        if (!parsedJson && lastWasTruncated && attempt < MAX_ATTEMPTS) {
          lastError = "Response truncated (finish_reason=length) — retrying with a larger token budget.";
          console.warn(`[attempt ${attempt}]`, lastError);
          continue;
        }

        if (rawText && !parsedJson) {
          parsedJson = robustJsonParse(rawText);
        }

        // ניקוי פעילויות ריקות - רץ גם על תוכניות משוחזרות חלקית
        if (parsedJson && parsedJson.days) {
            parsedJson.days = parsedJson.days.map((day: any) => {
              if (day.activities) {
                day.activities = day.activities.filter((act: any) => act.name && act.name.trim() !== "");
              }
              return day;
            });
          }
      } catch (err: any) {
        lastError = err.message;
      }
    }

    // === הועבר לצד לקוח ===
    // ב-Vercel Hobby (חינם) יש רק 10 שניות לפונקציה - אי אפשר להריץ כאן
    // לולאת geocoding עם 1.1 שניות המתנה לכל מקום (12 ימים = ~40 שניות!).
    // האימות עובר לדפדפן: geocode-client.ts רץ ברקע עם תור מצומצם
    // (בקשה אחת לשנייה, כפי ש-Nominatim דורש בשימוש הוגן) ומעדכן את
    // הנקודות על המפה תוך כדי שהמשתמש כבר קורא את התוכנית.
    // הפונקציה verifyAllLocations נשמרת כאן למקרה שתעבור לשרת חינמי
    // בלי מגבלת זמן (למשל Cloudflare Workers).

    if (!parsedJson) {
      console.error("=========================================");
      console.error("ALL ATTEMPTS FAILED. LAST ERROR:", lastError);
      console.error("RAW RESPONSE LENGTH:", rawResponseSnapshot.length);
      console.error("RAW RESPONSE FIRST 800 CHARS:");
      console.error(rawResponseSnapshot.substring(0, 800));
      console.error("RAW RESPONSE LAST 300 CHARS:");
      console.error(rawResponseSnapshot.substring(Math.max(0, rawResponseSnapshot.length - 300)));
      console.error("=========================================");
      
      // מנגנון גיבוי אוטומטי מלא למקרה קיצוני – מבטיח שהאפליקציה לעולם לא תקרוס
      parsedJson = {
        tripTitle: `תקלת עומס - לא ניתן לייצר את המסלול ל${destination}`,
        destination: destination,
        summary: `השגיאה האמיתית מהשרת: ${lastError || "unknown error"} | אורך תשובה: ${rawResponseSnapshot.length} תווים`,
        hotelRecommendation: "בשל עומס זמני על המערכת, לא הצלחנו להשלים את בניית המסלול. שווה לנסות שוב בעוד מספר שניות.",
        bookingLink: `https://www.booking.com/searchresults.html?ss=${encodeURIComponent(destination)}`,
        days: Array.from({ length: Number(days) || 3 }, (_, i) => ({
          day: i + 1,
          title: `יום ${i + 1} - שגיאת שרת`,
          activities: [
            {
              time: "09:00",
              name: "שגיאת מערכת (System Error)",
              description: "התשובה מה-AI נקטעה לפני סיום. אנא לחץ שוב על 'צור מסלול טיול'.",
              category: "שגיאה",
              lat: 0,
              lng: 0,
              ticketLink: ""
            },
            {
              time: "13:00",
              name: "שגיאת מערכת (System Error)",
              description: "התשובה מה-AI נקטעה לפני סיום. אנא לחץ שוב על 'צור מסלול טיול'.",
              category: "שגיאה",
              lat: 0,
              lng: 0,
              ticketLink: ""
            },
            {
              time: "17:00",
              name: "שגיאת מערכת (System Error)",
              description: "התשובה מה-AI נקטעה לפני סיום. אנא לחץ שוב על 'צור מסלול טיול'.",
              category: "שגיאה",
              lat: 0,
              lng: 0,
              ticketLink: ""
            }
          ]
        }))
      };
    }

    return NextResponse.json(parsedJson, { status: 200 });

  } catch (error: any) {
    console.error("Server Error:", error);
    return NextResponse.json({ error: error.message || "Internal server error occurred" }, { status: 500 });
  }
}