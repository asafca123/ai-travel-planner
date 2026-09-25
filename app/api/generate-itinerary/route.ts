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

// מנוע פענוח ותיקון JSON חסין לחלוטין
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

      const lengthConstraint = attempt > 1 || days > 5 
        ? "Keep activity descriptions concise but informative (1-2 sentences). Do not use 1-word descriptions."
        : "Provide rich, engaging, and detailed descriptions (2-3 sentences) explaining why this place is special.";

      const systemPrompt = `You are an expert travel planner AI. Return ONLY a valid JSON object starting with '{' and ending with '}'. 
All JSON keys MUST be in English, but text values MUST be in fluent Israeli Hebrew.

User's Custom Places / Google Maps List to Integrate (PRIORITY ANCHORS):
"${customPlaces || "None provided"}"

CRITICAL ANTI-HALLUCINATION, OPTIMIZATION & LOGISTICS RULES:
1. GEOGRAPHIC ANCHORING & COMMUTE LIMITS: Build each day's route geographically around the user's custom places. All activities MUST be inside the main destination city or within a short, realistic commute (max 1 hour). DO NOT suggest traveling to distant cities (e.g., Paris to Lyon for a day is forbidden).
2. MUST-SEE ATTRACTIONS: Even if specific travel styles are selected, you MUST include the absolute most iconic landmarks of the destination (e.g., Eiffel Tower, Louvre, Palace of Versailles in Paris), unless the user's custom places fill the entire schedule.
3. LIMIT ACTIVITIES: Generate exactly 3 to 5 activities per day. Do not generate endless lists.
4. NO SPECIFIC RESTAURANT NAMES: To save tokens and avoid hallucinations, DO NOT provide specific restaurant names. Instead, suggest a *type* of dining in the area (e.g., "מסעדת טאפאס מקומית ברובע הגותי").
5. STRICT REALITY CHECK: DO NOT INVENT PLACES. Every attraction MUST be a real, legally operating physical location. 
6. MAP COORDINATES: Every single activity MUST include accurate 'lat' and 'lng' numeric values.

CRITICAL RULES FOR SPORTS, CONCERTS & TICKETS:
7. SPORTS AS A SPECTATOR ONLY: If 'sports' is selected, DO NOT suggest stadium tours during the day. You MUST schedule EXACTLY ONE real professional match (e.g., PSG football, NFL, Tennis) at a logical time (e.g., 18:00, 20:00), and fill the rest of that day with NORMAL sightseeing and dining. 
8. BOOKING.COM LINK: Generate a specific URL in 'bookingLink' searching for the recommended neighborhood. Format: "https://www.booking.com/searchresults.html?ss=[Destination]+[Neighborhood]".
9. CONCERTS: If 'concerts' style is selected, suggest massive, real-world concerts happening around the travel dates. Provide a link to Ticketmaster or the official ticketing site in 'ticketLink'.
10. BILINGUAL NAMES & DESCRIPTIONS: Every activity 'name' MUST include the Hebrew name and the official English/Local name in parentheses. Example: "מגדל אייפל (Eiffel Tower)". The 'description' MUST be rich and descriptive, never just 2 words.
11. TICKETS: For attractions, museums, sports, or concerts, provide an official search link to buy tickets in the 'ticketLink' field. If not applicable, return "".

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
          "description": "Rich description here...",
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
      
      parsedJson = {
        tripTitle: `מסע מדהים אל ${destination}`,
        destination: destination,
        summary: `טיול מתוכנן היטב ליעד ${destination} למשך ${days} ימים בסגנון ${travelStyle}. חוויה עשירה ומגוונת המשלבת את המיטב שהעיר מציעה.`,
        hotelRecommendation: "האזור המומלץ ביותר ללינה במרכז העיר הוא הרובע המרכזי או אזור העיר העתיקה/החדשה המרכזית, המעניקים גישה נוחה ברגל ובתחבורה ציבורית לכל האטרקציות המרכזיות.",
        bookingLink: `https://www.booking.com/searchresults.html?ss=${encodeURIComponent(destination)}`,
        days: Array.from({ length: Number(days) || 3 }, (_, i) => ({
          day: i + 1,
          title: `יום ${i + 1} - סיור וגילוי בעיר`,
          activities: [
            {
              time: "09:00",
              name: "סיור בוקר במרכז העיר (City Center Morning Tour)",
              description: "התחלת היום בסיור רגלי מרתק באתרי המרכז ההיסטורי והתרבותי, ספיגת האווירה המקומית והיכרות עם האדריכלות הייחודית של העיר.",
              category: "תרבות",
              lat: 51.5074,
              lng: -0.1278,
              ticketLink: ""
            },
            {
              time: "13:00",
              name: "ארוחת צהריים בסגנון מקומי (Local Lunch Spot)",
              description: "הפסקה לארוחה אותנטית במסעדה מומלצת באזור הבילויים. הזדמנות מעולה לטעום מהמטבח המקומי.",
              category: "קולינריה",
              lat: 51.5084,
              lng: -0.1268,
              ticketLink: ""
            },
            {
              time: "17:00",
              name: "שוטטות ובילוי ערב (Evening Stroll)",
              description: "התרגעות בסוף היום, ספיגת האווירה המקומית ובילוי בערב באזורים התוססים של מרכז העיר.",
              category: "פנאי",
              lat: 51.5094,
              lng: -0.1258,
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