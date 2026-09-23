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
      
      const validModels = models.filter((id: string) => {
        const lower = id.toLowerCase();
        return !lower.includes("guard") &&
               !lower.includes("whisper") &&
               !lower.includes("audio") &&
               !lower.includes("embed") &&
               !lower.includes("vision");
      });

      const preferred = validModels.find((id: string) => 
        id.includes("llama-3.1-8b-instant") || 
        id.includes("llama-3.1-70b") ||
        id.includes("llama3")
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

// מנוע פענוח ותיקון JSON חסין לחלוטין
function robustJsonParse(text: string) {
  let cleaned = text.replace(/```json/gi, "").replace(/```/g, "").trim();

  try {
    return JSON.parse(cleaned);
  } catch (e) {}

  let firstOpen = cleaned.indexOf('{');
  let lastClose = cleaned.lastIndexOf('}');
  if (firstOpen !== -1 && lastClose !== -1 && lastClose > firstOpen) {
    let jsonCandidate = cleaned.substring(firstOpen, lastClose + 1);
    
    try {
      return JSON.parse(jsonCandidate);
    } catch (e2) {
      let repaired = jsonCandidate
        .replace(/[\u0000-\u001F]+/g, " ")
        .replace(/,\s*([\]}])/g, "$1")
        .replace(/([}\"])\s*([{\"])/g, "$1,$2")
        .replace(/([0-9truefalseull\]\)])\s*([{\["])/g, "$1,$2")
        .replace(/\n/g, " ");

      try {
        return JSON.parse(repaired);
      } catch (e3) {
        try {
          const evaluated = (new Function(`return ${jsonCandidate}`))();
          if (evaluated && typeof evaluated === 'object') {
            return evaluated;
          }
        } catch (e4) {
          throw new Error("JSON Repair failed: " + (e3 as Error).message);
        }
      }
    }
  }

  throw new Error("No JSON object boundaries found in response");
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
- High diversity, no repetition between days.`;

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
      console.error("JSON Parsing Error:", parseErr.message, "Raw text was:", rawText);
      return NextResponse.json({ error: "Failed to parse JSON: " + parseErr.message }, { status: 500 });
    }

    return NextResponse.json(parsedJson, { status: 200 });

  } catch (error: any) {
    console.error("Server Error:", error);
    return NextResponse.json({ error: error.message || "Internal server error occurred" }, { status: 500 });
  }
}