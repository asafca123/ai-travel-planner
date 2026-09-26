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

// מנוע פענוח ותיקון JSON חסין לחלוטין (מטפל בחיתוכי טוקנים, פסיקים ומבנים שבורים)
function robustJsonParse(text: string) {
  let cleaned = text.replace(/```json/gi, "").replace(/```/g, "").trim();

  try {
    return JSON.parse(cleaned);
  } catch (e) {}

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
    const MAX_ATTEMPTS = 2; 
    let lastError = "";

    while (attempt < MAX_ATTEMPTS && !parsedJson) {
      attempt++;

      const numDays = Number(days) || 3;
      
      // הגנה משולשת למסלולים ארוכים - עכשיו יש חוק ל-10+ ימים שימנע שגיאות 13 יום
      const lengthConstraint = numDays >= 10 
        ? "MASSIVE TRIP OPTIMIZATION: To prevent JSON truncation for 10+ days, you MUST generate EXACTLY 2 activities per day. Descriptions MUST be under 8 words. Never skip days."
        : (numDays >= 7 
          ? "LONG TRIP OPTIMIZATION: Keep activity descriptions concise and brief (1 short sentence max) to prevent JSON truncation. Generate exactly 3 activities per day."
          : "Provide diverse, rich, and detailed descriptions (2-3 sentences). Generate 3-5 activities per day.");

      const systemPrompt = `You are an expert travel planner AI. Return ONLY a valid JSON object starting with '{' and ending with '}'. 
All JSON keys MUST be in English, but text values MUST be in fluent Israeli Hebrew.

User's Custom Places / Google Maps List to Integrate (PRIORITY ANCHORS):
"${customPlaces || "None provided"}"

CRITICAL ANTI-HALLUCINATION & OPTIMIZATION RULES:
1. TYPO CORRECTION: If the user misspelled the destination (e.g. 'קלימנוש' instead of 'קלימנוס'), auto-correct it silently and plan for the real place.
2. EXACT LAND COORDINATES: Ensure 'lat' and 'lng' point precisely to the actual building, trail entrance, or beach on SOLID LAND. DO NOT place coordinates in the middle of the sea or ocean!
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
            temperature: 0.6,
            max_tokens: 8192
          }),
        });

        const responseText = await apiResponse.text();

        if (!apiResponse.ok) {
          lastError = responseText;
          continue; 
        }

        const data = JSON.parse(responseText);
        const rawText = data.choices?.[0]?.message?.content;
        
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