import { NextRequest, NextResponse } from "next/server";
import { ITINERARY_SYSTEM_PROMPT } from "@/lib/prompts";

let cachedModel: string | null = null;

// פונקציה דינמית שבודקת אילו מודלים זמינים באמת במפתח ה-API שלך ובוחרת את הטוב ביותר
async function getAvailableGroqModel(apiKey: string): Promise<string> {
  if (cachedModel) return cachedModel;

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
               !lower.includes("orpheus");
      });

      // חיפוש מודל מועדף מתוך אלו שזמינים אצלך בפועל
      const preferred = validModels.find((id: string) => 
        id.includes("llama-3.1-8b-instant") || 
        id.includes("llama-3.1-70b") ||
        id.includes("mixtral-8x7b") ||
        id.includes("gemma2") ||
        id.includes("llama3") ||
        id.includes("llama")
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

// מנוע תיקון ופענוח JSON חסין לחלוטין
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
        .replace(/}\s*\{/g, "},{")
        .replace(/\]\s*\[/g, "],[")
        .replace(/\n/g, " ");

      try {
        return JSON.parse(repaired);
      } catch (e3) {
        throw new Error("JSON Repair failed: " + (e3 as Error).message);
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

    // קבלת מודל פעיל שמותאם למפתח שלך
    const modelName = await getAvailableGroqModel(apiKey);

    const languageInstruction = language === "he"
      ? "CRITICAL RULE: All JSON keys MUST be in English (e.g., tripTitle, destination, days, activities, name, description, lat, lng), but all text values MUST be written in fluent, natural Israeli Hebrew."
      : "All JSON keys and values MUST be in English.";

    const routingInstruction = 
      "CRITICAL RULES:\n" +
      "1. Return ONLY a valid JSON object starting with '{' and ending with '}'.\n" +
      "2. DESTINATION COORDINATES: Every single activity MUST have real, precise latitude (lat) and longitude (lng) strictly located INSIDE the requested destination (" + destination + ").\n" +
      "3. COMPLETE DAYS COVERAGE: Generate ALL requested days (Day 1 through Day " + days + ") fully without skipping.\n" +
      "4. Starting Point: " + (startPoint || destination) + ".";

    const userPrompt = `Destination: ${destination}\nStarting Point: ${startPoint || "N/A"}\nStart Date: ${startDate || "N/A"}\nDays: ${days}\nTravel style: ${travelStyle}\nInstruction: ${languageInstruction}\n${routingInstruction}`;

    const combinedPrompt = `${ITINERARY_SYSTEM_PROMPT}\n\n=== USER REQUEST ===\n${userPrompt}`;

    const apiResponse = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: modelName,
        messages: [
          { role: "user", content: combinedPrompt }
        ],
        temperature: 0.1,
        max_tokens: 4096,
        response_format: { type: "json_object" }
      }),
    });

    const responseText = await apiResponse.text();

    if (!apiResponse.ok) {
      console.error("===== GROQ API ERROR =====", responseText);
      cachedModel = null; // איפוס הקאש למקרה שהמודל נחסם
      return NextResponse.json({ error: `Groq API Error: ${responseText}` }, { status: 500 });
    }

    let data;
    try {
      data = JSON.parse(responseText);
    } catch (parseErr) {
      return NextResponse.json({ error: "Invalid JSON response from Groq wrapper", raw: responseText }, { status: 500 });
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