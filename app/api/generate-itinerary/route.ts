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

      // חיסכון בטוקנים פועל אך ורק למסלולים של שבוע ומעלה
      const lengthConstraint = attempt > 1 || Number(days) >= 7 
        ? "LONG TRIP OPTIMIZATION: Keep activity descriptions concise and brief (1 short sentence max) to prevent JSON truncation."
        : "Provide diverse, rich, and detailed descriptions (2-3 sentences).";

      const systemPrompt = `You are an expert travel planner AI. Return ONLY a valid JSON object starting with '{' and ending with '}'. 
All JSON keys MUST be in English, but text values MUST be in fluent Israeli Hebrew.

User's Custom Places / Google Maps List to Integrate (PRIORITY ANCHORS):
"${customPlaces || "None provided"}"

CRITICAL LOGISTICS & ACCURACY RULES:
1. EXACT LAND COORDINATES: Ensure 'lat' and 'lng' point precisely to the actual building, trail entrance, beach, or marina on LAND. DO NOT place coordinates in the middle of the sea or ocean!
2. ABSOLUTELY NO REPETITION: Every single day and activity MUST be 100% unique. DO NOT repeat the same boat tour, the same waterfall, or the same beach twice. Diversify the experiences completely.
3. EXTREME SPORTS EXPERT: If 'extreme sports' is selected, act as a local pro! Name specific world-famous climbing sectors/routes (e.g., 'Ton Sai Wall', 'Bouldering at...'), distinct surf breaks (e.g., 'Point break at...', 'Reef break at...'), or exact dive sites. Use authentic terminology. Provide a link to Surfline, MagicSeaweed, or Mountain Project in the 'ticketLink' field so they can check conditions/routes.
4. DESTINATION DNA: If 'relaxed' is selected in tropical destinations, dedicate significant time to lounging at different beaches or resorts.
5. OBSCURE DESTINATIONS: If the destination is a small town, island, or off the beaten path, DO NOT INVENT generic museums or fake attractions. Rely strictly on real nature, geography, or authentic local life.
6. GEOGRAPHIC ANCHORING & COMMUTE: All activities MUST be within a realistic commute (max 1 hour). DO NOT suggest traveling to distant cities.
7. MUST-SEE ATTRACTIONS: You MUST include the absolute most iconic landmarks of the destination, unless the user's custom places fill the schedule.
8. NO SPECIFIC RESTAURANT NAMES: To save tokens and avoid hallucinations, DO NOT provide specific restaurant names. Instead, suggest a *type* of dining (e.g., "טברנה מקומית על החוף").

CRITICAL RULES FOR BILINGUAL NAMES, TICKETS & EVENTS:
9. BILINGUAL NAMES: Every activity 'name' MUST include the Hebrew name and the official English/Local name in parentheses. Example: "מפרץ הגולשים (Surfer's Bay)".
10. BOOKING.COM LINK: Generate a specific URL in 'bookingLink' searching for the recommended neighborhood. Format: "https://www.booking.com/searchresults.html?ss=[Destination]+[Neighborhood]".
11. ZERO HALLUCINATION FOR EVENTS (SPORTS/CONCERTS): If 'sports' or 'concerts' are selected, ONLY suggest MASSIVE, world-class arena/stadium events (e.g., top-tier football, NFL, Stevie Wonder) IF AND ONLY IF you have 100% factual knowledge they happen on these exact dates in the destination. Otherwise, IGNORE the request completely and suggest normal sightseeing. No local bars with live music, no empty stadium tours.
12. TICKETS: For proven events, museums, or professional sports routes/surf spots, provide an official website, Surfline/Mountain Project link, or a search link to buy tickets in 'ticketLink'. If not applicable, return "".

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
- Limit to exactly 3 to 5 activities per day.
- Write in natural, engaging Hebrew.
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