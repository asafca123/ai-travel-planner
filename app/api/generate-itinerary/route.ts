import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 60;

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
  const HARD_CAP = 32000;
  const baseTokens = 3500;
  const perDayTokens = 1500;
  let budget = baseTokens + numDays * perDayTokens;

  // בכל ניסיון חוזר (במקרה של חיתוך) מגדילים את התקציב משמעותית
  if (attempt >= 2) budget = Math.max(budget, budget * 1.6);
  if (attempt >= 3) budget = HARD_CAP;

  return Math.min(HARD_CAP, Math.round(budget));
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

    let parsedJson = null;
    let attempt = 0;
    const MAX_ATTEMPTS = 3;
    let lastError = "";
    let lastWasTruncated = false;

    while (attempt < MAX_ATTEMPTS && !parsedJson) {
      attempt++;

      const numDays = Number(days) || 3;
      
      // === עודכן: משטר תוכן לטיולים ארוכים ===
      // בעבר הצמצום החד (2-3 פעילויות, תיאורים מתחת ל-10 מילים) היה נועד
      // לעקוף את בעיית חיתוך הטוקנים. עכשיו שתקציב הטוקנים מחושב נכון
      // ומספיק גם לטיולים ארוכים, אין צורך "לחסוך" למשתמש על חשבון
      // איכות המסלול - רק לטיולים ארוכים מאוד (10+ ימים) שומרים על מתינות קלה.
      const lengthConstraint = numDays >= 10
        ? "For very long trips (10+ days): generate 3-4 activities per day with concise but complete descriptions (1-2 sentences each) so the full trip fits within the response."
        : "Provide diverse, rich, and detailed descriptions (2-3 sentences). Generate 3-5 activities per day.";

      const systemPrompt = `You are an expert travel planner AI. Return ONLY a valid JSON object starting with '{' and ending with '}'. 
All JSON keys MUST be in English, but text values MUST be in fluent Israeli Hebrew.

User's Custom Places / Google Maps List to Integrate (PRIORITY ANCHORS):
"${customPlaces || "None provided"}"

CRITICAL ANTI-HALLUCINATION & OPTIMIZATION RULES:
1. TYPO CORRECTION: If the user misspelled the destination (e.g. 'קלימנוש' instead of 'קלימנוס'), auto-correct it silently and plan for the real place.
2. EXACT GOOGLE MAPS LOCATIONS & NO CITY-CENTER DUMPING: Ensure 'lat' and 'lng' point precisely to the actual building, trail entrance, or beach on SOLID LAND. If you do not know the exact coordinates of a specific cliff or beach, DO NOT fallback to the "city center" or main port (this leads to hallucinations). Instead, fallback to the broader verifiable geographical feature on Google Maps (e.g., the specific National Park, nature reserve, or exact coastal strip). NEVER guess water coordinates!
3. DESTINATION DNA & EXTREME SPORTS: If 'extreme sports' is selected, analyze what the destination is actually famous for. For example, Kalymnos is for rock climbing (not surfing). Siargao is for surfing. Suggest ONLY the correct sport, use professional terminology, and link to professional sites (e.g., Mountain Project, Surfline).
4. OBSCURE DESTINATIONS: If the destination is a small town, island, or off the beaten path, DO NOT INVENT generic museums or fake attractions. Rely strictly on real nature, geography, or authentic local life.
5. NO SPECIFIC RESTAURANT NAMES: To save tokens and avoid hallucinations, DO NOT provide specific restaurant names. Instead, suggest a *type* of dining in the area.
6. GEOGRAPHIC ANCHORING & COMMUTE: All activities MUST be within a realistic commute (max 1 hour).
7. SMART REPETITION: DO NOT repeat specific tours, museums, or landmarks. However, you MAY freely repeat visits to beautiful beaches, pools, or nature relaxation spots on different days.

CRITICAL RULES FOR BILINGUAL NAMES, TICKETS & EVENTS:
8. BILINGUAL NAMES & PROPER TRANSLITERATION: Every activity 'name' MUST include the Hebrew name and the official English/Local name in parentheses. CRITICAL: DO NOT literally translate proper nouns! Transliterate them (e.g., 'Southbank Centre' should be 'מרכז סאות'בנק'). Only translate generic words like Park, Museum, Beach.
9. BOOKING.COM LINK: Generate a specific URL in 'bookingLink' searching for the recommended neighborhood. Format: "https://www.booking.com/searchresults.html?ss=[Destination]+[Neighborhood]".
10. ZERO HALLUCINATION FOR EVENTS (SPORTS/CONCERTS): ONLY suggest MASSIVE, world-class arena/stadium events (e.g., top-tier football, NFL, Stevie Wonder) IF AND ONLY IF you have 100% factual knowledge they happen on these exact dates in the destination. Otherwise, IGNORE the request completely and suggest normal sightseeing. No empty stadium tours.
11. TICKETS: For proven events or museums, provide an official website or a search link to buy tickets in the 'ticketLink' field. If not applicable, return an empty string "".

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

      const attemptMaxTokens = computeMaxTokens(numDays, attempt);

      try {
        const apiResponse = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: modelName,
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: userPrompt }
            ],
            temperature: 0.7, // חזרנו לטמפרטורה נורמלית כדי למנוע את הלולאות והחזרתיות של המקומות
            max_tokens: attemptMaxTokens,
            // חדש: Groq/OpenAI מיישנים בהדרגה את max_tokens לטובת max_completion_tokens.
            // שולחים את שניהם כדי להישאר תואמים גם כשהתמיכה ב-max_tokens תוסר.
            max_completion_tokens: attemptMaxTokens
          }),
        });

        const responseText = await apiResponse.text();

        if (!apiResponse.ok) {
          lastError = responseText;
          continue; 
        }

        const data = JSON.parse(responseText);
        const rawText = data.choices?.[0]?.message?.content;
        const finishReason = data.choices?.[0]?.finish_reason;
        lastWasTruncated = finishReason === "length";

        // חדש: אם התשובה נחתכה עקב מגבלת טוקנים ועוד נשארו ניסיונות,
        // עדיף לנסות שוב מיד עם תקציב טוקנים גדול יותר במקום לנסות
        // לתקן JSON חלקי (זה בדיוק מה שגרם למסך השגיאה בעבר).
        if (lastWasTruncated && attempt < MAX_ATTEMPTS) {
          lastError = "Response truncated (finish_reason=length) — retrying with a larger token budget.";
          continue;
        }
        
        if (rawText) {
          parsedJson = robustJsonParse(rawText);
          
          if (parsedJson && parsedJson.days) {
            parsedJson.days = parsedJson.days.map((day: any) => {
              if (day.activities) {
                day.activities = day.activities.filter((act: any) => act.name && act.name.trim() !== "");
              }
              return day;
            });
          }
        }
      } catch (err: any) {
        lastError = err.message;
      }
    }

    if (!parsedJson) {
      console.error("All attempts failed. Last error:", lastError);
      
      // מנגנון גיבוי אוטומטי מלא למקרה קיצוני – מבטיח שהאפליקציה לעולם לא תקרוס
      parsedJson = {
        tripTitle: `תקלת עומס - לא ניתן לייצר את המסלול ל${destination}`,
        destination: destination,
        summary: `אופס! נראה שהמסלול שניסינו לייצר ל-${destination} למשך ${days} ימים היה ארוך או עמוס מדי, והשרת חתך את התשובה באמצע. אנא נסה ללחוץ שוב על כפתור יצירת המסלול.`,
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