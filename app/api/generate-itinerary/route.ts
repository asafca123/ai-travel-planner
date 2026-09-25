import { NextRequest, NextResponse } from "next/server";

// מאפשר לשרת לרוץ עד 60 שניות מבלי ש-Vercel יחתוך את הבקשה
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
        id.includes("llama-3.1-8b-instant")
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

  cachedModel = "llama-3.3-70b-versatile";
  return cachedModel;
}

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

      // בטיולים ארוכים, אנחנו דורשים ממנו לקצר מעט כדי להבטיח שה-JSON לא ייחתך בעברית
      const lengthConstraint = attempt > 1 || days > 5 
        ? "CRITICAL: Keep activity descriptions extremely brief (max 10 words) to prevent token overflow."
        : "Provide diverse and engaging descriptions in Hebrew.";

      const systemPrompt = `You are an expert travel planner AI. Return ONLY a valid JSON object starting with '{' and ending with '}'. 

User's Custom Places / Google Maps List to Integrate (PRIORITY ANCHORS):
"${customPlaces || "None provided"}"

CRITICAL ANTI-HALLUCINATION & OPTIMIZATION RULES:
1. GEOGRAPHIC ANCHORING: Build each day's route geographically around the user's custom places.
2. LIMIT ACTIVITIES: Generate exactly 3 to 4 activities per day maximum.
3. NO SPECIFIC RESTAURANT NAMES: To save tokens, DO NOT provide specific restaurant names. Suggest a *type* of dining (e.g., "מסעדה מקומית מומלצת", "בית קפה ברובע").
4. MAP COORDINATES: Every single activity MUST include accurate 'lat' and 'lng' numeric values.

CRITICAL RULES FOR HEBREW & TICKETS:
5. NATIVE HEBREW: You MUST write in natural, modern, and fluent Israeli Hebrew. DO NOT use robotic or literal translations. 
6. NAMING CONVENTIONS: Use accepted Hebrew names for famous landmarks (e.g., 'מגדל אייפל', not 'אייפל טאוור'). If a place doesn't have a known Hebrew name, leave it in English or the local language.
7. TICKETS: For attractions, museums, or events, provide an official website or a search link to buy tickets in the 'ticketLink' field. If not applicable (e.g., a park, walking around, or restaurant), return an empty string "".

Required JSON Structure:
{
  "tripTitle": "...",
  "destination": "...",
  "summary": "...",
  "hotelRecommendation": "המלצה מפורטת על אזור או שכונה מומלצת בהתאם לסגנון (ללא שמות מלונות)",
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
          "lng": 34.8,
          "ticketLink": "https://..."
        }
      ]
    }
  ]
}

Rules:
- Generate ALL requested days (Day 1 through Day ${days}) fully without skipping.
- High diversity, no repetition between days. Write in natural Hebrew.
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
            // הוסר אילוץ ה-json_object כדי למנוע קריסות שרת בטקסטים ארוכים בעברית (חיתוך טוקנים)
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: userPrompt }
            ],
            temperature: 0.6,
            max_tokens: 8192 // הוכפל כדי לתמוך בטיולים ארוכים
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

    // רשת הביטחון הסופית המקורית - למקרה חירום קיצוני
    if (!parsedJson) {
      console.error("All attempts failed. Last error:", lastError);
      parsedJson = {
        tripTitle: `מסלול ל${destination}`,
        destination: destination,
        summary: `מסלול זה נוצר בתבנית בסיסית בעקבות עומס זמני על השרתים. כדי לקבל את המסלול המלא, אנא נסה לרענן את העמוד בעוד מספר דקות.`,
        hotelRecommendation: `אזור מרכז העיר או הרובע ההיסטורי ב${destination} מומלצים ללינה כדי להיות קרובים לאטרקציות המרכזיות.`,
        days: Array.from({ length: Number(days) || 3 }, (_, i) => ({
          day: i + 1,
          title: `יום ${i + 1} - חוקרים את ${destination}`,
          activities: [
            {
              time: "10:00",
              name: `סיור בוקר ב${destination}`,
              description: "תחילת היום באטרקציות המרכזיות של האזור.",
              category: "תרבות",
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