import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  try {
    const { messages, itineraryContext } = await req.json();

    if (!messages || !Array.isArray(messages)) {
      return NextResponse.json({ error: "Invalid messages format" }, { status: 400 });
    }

    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: "GROQ_API_KEY is missing" }, { status: 500 });
    }

    const systemPrompt = `You are VoyageAI's personal travel assistant. 
The user is planning a trip. Here is their current generated itinerary JSON for context:
${JSON.stringify(itineraryContext || {})}

Your goal is to help the user modify, improve, or add to this itinerary. 
Always answer in natural, friendly, fluent Israeli Hebrew.
Keep your answers concise, practical, and helpful. Suggest real places and practical advice.`;

    const apiResponse = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        messages: [
          { role: "system", content: systemPrompt },
          ...messages
        ],
        temperature: 0.7,
        max_tokens: 1024
      }),
    });

    if (!apiResponse.ok) {
      throw new Error(`Groq API error: ${await apiResponse.text()}`);
    }

    const data = await apiResponse.json();
    return NextResponse.json({ reply: data.choices[0].message.content }, { status: 200 });

  } catch (error: any) {
    console.error("Chat Error:", error);
    return NextResponse.json({ error: error.message || "Chat server error" }, { status: 500 });
  }
}