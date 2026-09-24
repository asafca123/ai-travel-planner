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
    const MAX_ATTEMPTS = 2; // נותן למערכת הזדמנות שנייה להתאושש משגיאות מודל
    let lastError = "";

    while (attempt < MAX_ATTEMPTS && !parsedJson) {
      attempt++;

      const lengthConstraint = attempt > 1 || days > 5 
        ? "LONG TRIP OPTIMIZATION: Keep activity descriptions concise and brief (1 short sentence max) to prevent JSON truncation."
        : "Provide diverse and interesting descriptions.";

      const systemPrompt = `You are an expert travel planner AI. Return ONLY a valid JSON object starting with '{' and ending with '}'. 
All JSON keys MUST be in English, but text values MUST be in fluent Israeli Hebrew.

User's Custom Places / Google Maps List to Integrate (PRIORITY ANCHORS):
"${customPlaces || "None provided"}"

CRITICAL ANTI-HALLUCINATION & OPTIMIZATION RULES:
1. GEOGRAPHIC ANCHORING: Build each day's route geographically around the user's custom places (if provided).
2. LIMIT ACTIVITIES: Generate exactly 3 to 5 activities per day. Do not generate endless lists.
3. NO SPECIFIC RESTAURANT NAMES: To save tokens and avoid hallucinations, DO NOT provide specific restaurant names. Instead, suggest a *type* of dining in the area (e.g., "מסעדת טאפאס מקומית ברובע הגותי", "בית קפה אותנטי ליד המוזיאון").
4. STRICT REALITY CHECK: DO NOT INVENT PLACES. Every attraction, casino, or extreme sport spot MUST be a real, legally operating, and verifiable physical location. 
5. MAP COORDINATES: Every single activity MUST include accurate 'lat' and 'lng' numeric values.

Required JSON Structure:
{
  "tripTitle": "...",
  "destination": "...",
  "summary": "...",
  "hotelRecommendation": "המלצה מפורטת על האזור או השכונה המומלצת ביותר במרכז העיר בהתאם לסגנון (ללא שמות מלונות ספציפיים, רק אזורים ושכונות).",
  "days": [
    {
      "day": 1,
      "title": "...",
      "activities": [
        {
          "time": "09:00",
          "name": "...",
          "description": "...",
          "category": "...",
          "lat": 31.0,
          "lng": 34.8
        }
      ]
    }
  ]
}

Rules:
- Generate ALL requested days (Day 1 through Day ${days}) fully without skipping.
- Sports: Max 1 event, only if a real professional match occurs on the exact dates starting ${startDate || "today"}.
- Casino: Max 1 time in the whole trip.
- Nightlife: Minimal and balanced, not every night.
- 'hotelRecommendation' MUST recommend areas or neighborhoods in the city center, DO NOT recommend specific hotel names.
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
            response_format: { type: "json_object" },
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: userPrompt }
            ],
            temperature: 0.7, // טמפרטורה בריאה שמונעת חזרתיות ולולאות
            top_p: 0.9,
            max_tokens: 4096
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
          
          // ניקוי כרטיסיות ריקות במקרה שהמודל המציא פריטים ללא שם
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
      return NextResponse.json({ error: "המערכת חוותה עומס מול שרתי ה-AI. אנא נסה שוב בעוד מספר שניות." }, { status: 500 });
    }

    return NextResponse.json(parsedJson, { status: 200 });

  } catch (error: any) {
    console.error("Server Error:", error);
    return NextResponse.json({ error: error.message || "Internal server error occurred" }, { status: 500 });
  }
}