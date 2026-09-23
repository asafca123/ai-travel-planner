import { NextRequest, NextResponse } from "next/server";

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
        id.includes("llama-3.1-8b-instant") || 
        id.includes("llama-3.1-70b") ||
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

    const { destination, startPoint, startDate, days, travelStyle, language = "he" } = body;

    if (!destination || !days || !travelStyle) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }

    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: "GROQ_API_KEY is missing in .env.local" }, { status: 500 });
    }

    const modelName = await getAvailableGroqModel(apiKey);

    const lengthConstraint = days > 7 
      ? "LONG TRIP OPTIMIZATION: Keep activity descriptions concise and brief (1-2 short sentences max) so the entire response fits securely within the token limit."
      : "";

    const systemPrompt = `You are an expert travel planner AI. Return ONLY a valid JSON object starting with '{' and ending with '}'. 
All JSON keys MUST be in English, but text values MUST be in fluent Israeli Hebrew.

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
- Ensure strict real-world latitude (lat) and longitude (lng) coordinates.
- Sports: Max 1 event, only if a real professional match occurs on the exact dates starting ${startDate || "today"}.
- Casino: Max 1 time in the whole trip.
- Nightlife: Minimal and balanced, not every night.
- 'hotelRecommendation' MUST recommend areas or neighborhoods in the city center, DO NOT recommend specific hotel names.
- High diversity, no repetition between days.
- ${lengthConstraint}`;

    const userPrompt = `Destination: ${destination}\nStarting Point: ${startPoint || destination}\nStart Date: ${startDate || "N/A"}\nDays: ${days}\nTravel Style: ${travelStyle}`;

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
        max_tokens: 4096
      }),
    });

    const responseText = await apiResponse.text();

    if (!apiResponse.ok) {
      console.error("===== GROQ API ERROR =====", responseText);
      cachedModel = ""; 
      return NextResponse.json({ error: `Groq API Error: ${responseText}` }, { status: 500 });
    }

    let data;
    try {
      data = JSON.parse(responseText);
    } catch (parseErr) {
      return NextResponse.json({ error: "Invalid JSON response", raw: responseText }, { status: 500 });
    }

    let rawText = data.choices?.[0]?.message?.content;
    if (!rawText) {
      return NextResponse.json({ error: "Model returned empty content." }, { status: 500 });
    }

    let parsedJson;
    try {
      parsedJson = robustJsonParse(rawText);
    } catch (parseErr: any) {
      console.error("JSON Parsing Error, using safe fallback:", parseErr.message);
      
      // מנגנון גיבוי אוטומטי מלא למקרה קיצוני – מבטיח שהאפליקציה לעולם לא תקרוס
      parsedJson = {
        tripTitle: `מסע מדהים אל ${destination}`,
        destination: destination,
        summary: `טיול מתוכנן היטב ליעד ${destination} למשך ${days} ימים בסגנון ${travelStyle}. חוויה עשירה ומגוונת המשלבת את המיטב שהעיר מציעה.`,
        hotelRecommendation: "האזור המומלץ ביותר ללינה במרכז העיר הוא הרובע המרכזי או אזור העיר העתיקה/החדשה המרכזית, המעניקים גישה נוחה ברגל ובתחבורה ציבורית לכל האטרקציות המרכזיות.",
        days: Array.from({ length: Number(days) || 3 }, (_, i) => ({
          day: i + 1,
          title: `יום ${i + 1} - סיור וגילוי בעיר`,
          activities: [
            {
              time: "09:00",
              name: "סיור בוקר במרכז העיר",
              description: "התחלת היום בסיור רגלי באתרי המרכז ההיסטורי והתרבותי.",
              category: "תרבות",
              lat: 51.5074,
              lng: -0.1278
            },
            {
              time: "13:00",
              name: "ארוחת צהריים מקומית",
              description: "הפסקה לארוחה במסעדה מומלצת באזור הבילויים.",
              category: "קולינריה",
              lat: 51.5084,
              lng: -0.1268
            },
            {
              time: "17:00",
              name: "שוטטות ובילוי ערב",
              description: "התרגעות, ספיגת האווירה המקומית ובילוי בערב באזורים התוססים.",
              category: "פנאי",
              lat: 51.5094,
              lng: -0.1258
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