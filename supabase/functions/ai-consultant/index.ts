// AI Financial Consultant Edge Function
//
// Proxies user messages to an AI provider (OpenAI) server-side so the API key
// never reaches the browser. Authenticates via the Supabase JWT, enforces a
// per-user daily message limit, and persists all messages to ai_conversations
// / ai_messages so conversation history is maintained across sessions.
//
// Required secret: OPENAI_API_KEY (configured via Supabase dashboard or CLI).
// If the secret is missing, the function returns a clear error so the frontend
// can inform the user — it never pretends to work.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const MAX_DAILY_MESSAGES = 30;
const SYSTEM_PROMPT = `Anda adalah Konsultan Keuangan AI Finora — asisten keuangan pribadi yang membantu pengguna berbahasa Indonesia.

PRINSIP KERJA:
1. Jawab selalu dalam bahasa Indonesia yang natural dan mudah dipahami.
2. Anda adalah pendidik keuangan, BUKAN penasihat keuangan berizin (regulated financial advisor). Selalu klarifikasi: "Ini adalah edukasi keuangan, bukan saran dari penasihat keuangan berizin."
3. JANGAN PERNAH menjamin imbal hasil investasi. Gunakan kata "diperkirakan" atau "berpotensi" untuk proyeksi.
4. JANGAN PERNAH menghitung angka finansial sendiri. Jika pengguna meminta perhitungan, arahkan mereka ke fitur Analisis Keuangan atau Transaksi di Finora. Jika data finansial disertakan dalam pesan atau melalui persetujuan profil, gunakan angka tersebut apa adanya — jangan dibuat-buat angka baru.
5. Jika informasi pengguna tidak lengkap untuk memberikan jawaban relevan, AJUKAN PERTANYAAN KLARIFIKASI terlebih dahulu sebelum memberikan rekomendasi. Jangan berasumsi tentang angka atau situasi yang tidak disebutkan.
6. Berikan rekomendasi langkah demi langkah yang realistis dan dapat ditindaklanjuti.
7. Jika pengguna memberikan data profil finansial (dengan persetujuan), gunakan data tersebut sebagai konteks untuk jawaban yang lebih personal.
8. Ketika membandingkan skenario keuangan (misalnya dua strategi pelunasan utang atau dua pilihan anggaran), gunakan HANYA angka yang telah diverifikasi — yakni angka yang diberikan pengguna atau data profil yang disertakan. Jangan mengarang angka perbandingan. Tampilkan perbandingan dalam struktur yang jelas (tabel atau daftar bersisian) dan jelaskan konsekuensi logis dari masing-masing skenario berdasarkan angka tersebut.
9. Jelaskan masalah keuangan dengan bahasa sederhana sebelum memberikan solusi. Pastikan pengguna memahami akar masalahnya terlebih dahulu.

FORMAT JAWABAN:
- Gunakan paragraf singkat dan jelas.
- Untuk langkah-langkah, gunakan penomoran.
- Jika membandingkan skenario, tampilkan dengan struktur yang mudah dibaca (daftar bersisian atau tabel sederhana).
- Jika informasi tidak cukup, mulai dengan pertanyaan klarifikasi sebelum memberikan jawaban.
- Selalu akhiri dengan penegasan bahwa ini adalah edukasi, bukan saran terikat regulasi.`;

interface ChatRequest {
  message: string;
  conversationId?: string;
  includeProfile?: boolean;
  profileData?: {
    monthlyIncome: number;
    essentialExpenses: number;
    nonEssentialExpenses: number;
    debtBalances: number;
    monthlyInstallments: number;
    savings: number;
    financialDependents: number;
    emergencyFund: number;
    recentTransactions?: { description: string; amount: number; type: string; category: string }[];
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({ error: "Metode tidak didukung" }),
      { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  try {
    // ─── 1. Authenticate via JWT ────────────────────────────────
    const authHeader = req.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return new Response(
        JSON.stringify({ error: "Otorisasi diperlukan" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    // Create a supabase client with the user's JWT to verify identity
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: { user }, error: authError } = await userClient.auth.getUser();
    if (authError || !user) {
      return new Response(
        JSON.stringify({ error: "Sesi tidak valid. Silakan masuk kembali." }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Service role client for DB operations (bypasses RLS)
    const adminClient = createClient(supabaseUrl, serviceRoleKey);

    // ─── 2. Rate limiting: count messages today ────────────────
    const today = new Date().toISOString().split("T")[0];
    const { count: todayCount } = await adminClient
      .from("ai_messages")
      .select("*", { count: "exact", head: true })
      .eq("user_id", user.id)
      .gte("created_at", `${today}T00:00:00Z`);

    if ((todayCount ?? 0) >= MAX_DAILY_MESSAGES) {
      return new Response(
        JSON.stringify({
          error: `Batas harian tercapai. Anda telah mengirim ${MAX_DAILY_MESSAGES} pesan hari ini. Coba lagi besok.`,
        }),
        { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ─── 3. Parse request body ─────────────────────────────────
    const body: ChatRequest = await req.json();
    const { message, conversationId, includeProfile, profileData } = body;

    if (!message || !message.trim()) {
      return new Response(
        JSON.stringify({ error: "Pesan tidak boleh kosong" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ─── 4. Get or create conversation ─────────────────────────
    let convId = conversationId;
    if (!convId) {
      const title = message.trim().slice(0, 60) + (message.length > 60 ? "..." : "");
      const { data: newConv, error: convError } = await adminClient
        .from("ai_conversations")
        .insert({ user_id: user.id, title })
        .select("id")
        .single();

      if (convError || !newConv) {
        return new Response(
          JSON.stringify({ error: "Gagal membuat percakapan" }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      convId = newConv.id;
    } else {
      // Verify ownership
      const { data: conv } = await adminClient
        .from("ai_conversations")
        .select("id, user_id")
        .eq("id", convId)
        .maybeSingle();

      if (!conv || conv.user_id !== user.id) {
        return new Response(
          JSON.stringify({ error: "Percakapan tidak ditemukan" }),
          { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    // ─── 5. Save user message ──────────────────────────────────
    await adminClient
      .from("ai_messages")
      .insert({
        conversation_id: convId,
        user_id: user.id,
        role: "user",
        content: message.trim(),
      });

    // ─── 6. Fetch conversation history (last 20 messages) ──────
    const { data: history } = await adminClient
      .from("ai_messages")
      .select("role, content")
      .eq("conversation_id", convId)
      .order("created_at", { ascending: true })
      .limit(20);

    // ─── 7. Build messages array for AI API ────────────────────
    const messages: { role: string; content: string }[] = [
      { role: "system", content: SYSTEM_PROMPT },
    ];

    // If user consented to share profile data, append as context
    if (includeProfile && profileData) {
      let profileContext = `\n\nDATA PROFIL KEUANGAN PENGGUNA (dengan persetujuan eksplisit):\n`;
      profileContext += `- Pendapatan Bulanan: Rp ${profileData.monthlyIncome.toLocaleString("id-ID")}\n`;
      profileContext += `- Pengeluaran Wajib: Rp ${profileData.essentialExpenses.toLocaleString("id-ID")}\n`;
      profileContext += `- Pengeluaran Non-Wajib: Rp ${profileData.nonEssentialExpenses.toLocaleString("id-ID")}\n`;
      profileContext += `- Total Saldo Utang: Rp ${profileData.debtBalances.toLocaleString("id-ID")}\n`;
      profileContext += `- Cicilan Bulanan: Rp ${profileData.monthlyInstallments.toLocaleString("id-ID")}\n`;
      profileContext += `- Total Tabungan: Rp ${profileData.savings.toLocaleString("id-ID")}\n`;
      profileContext += `- Jumlah Tanggungan: ${profileData.financialDependents} orang\n`;
      profileContext += `- Dana Darurat: Rp ${profileData.emergencyFund.toLocaleString("id-ID")}\n`;

      if (profileData.recentTransactions && profileData.recentTransactions.length > 0) {
        profileContext += `\nTRANSAKSI TERBARU:\n`;
        for (const tx of profileData.recentTransactions.slice(0, 10)) {
          profileContext += `- ${tx.description} | ${tx.type === "income" ? "Pemasukan" : "Pengeluaran"} | ${tx.category} | Rp ${tx.amount.toLocaleString("id-ID")}\n`;
        }
      }

      profileContext += `\nGunakan data ini untuk memberikan jawaban yang lebih personal. Jangan menghitung ulang angka ini — gunakan apa adanya.`;
      messages.push({ role: "system", content: profileContext });
    }

    // Append conversation history
    for (const msg of history ?? []) {
      messages.push({ role: msg.role, content: msg.content });
    }

    
// 8. Call AI API: OpenAI Primary + Gemini Fallback

const openaiKey = Deno.env.get("OPENAI_API_KEY");
const geminiKey = Deno.env.get("GEMINI_API_KEY");

const geminiModel =
  Deno.env.get("GEMINI_MODEL") || "gemini-2.5-flash";

// Ubah riwayat percakapan menjadi format OpenAI
const openaiMessages = [
  {
    role: "system",
    content: SYSTEM_PROMPT,
  },
  ...history.map((msg: any) => ({
    role: msg.role,
    content: msg.content,
  })),
];

// Fungsi pemanggilan OpenAI
async function callOpenAI(): Promise<string> {
  if (!openaiKey) {
    throw new Error("OPENAI_NOT_CONFIGURED");
  }

  const response = await fetch(
    "https://api.openai.com/v1/chat/completions",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${openaiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: openaiMessages,
        temperature: 0.7,
      }),
    }
  );

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    const errorCode = errorData?.error?.code;

    // Hanya gangguan sementara atau kuota yang memicu fallback
    if (
      response.status === 429 ||
      response.status >= 500
    ) {
      throw new Error("OPENAI_TEMPORARY_ERROR");
    }

    if (errorCode === "insufficient_quota") {
      throw new Error("OPENAI_TEMPORARY_ERROR");
    }

    throw new Error("OPENAI_REQUEST_ERROR");
  }

  const data = await response.json();
  const answer = data?.choices?.[0]?.message?.content;

  if (!answer) {
    throw new Error("OPENAI_EMPTY_RESPONSE");
  }

  return answer;
}

// Fungsi pemanggilan Gemini
async function callGemini(): Promise<string> {
  if (!geminiKey) {
    throw new Error("GEMINI_NOT_CONFIGURED");
  }

  const contents = history.map((msg: any) => ({
    role: msg.role === "assistant" ? "model" : "user",
    parts: [{ text: msg.content }],
  }));

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${geminiKey}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: SYSTEM_PROMPT }],
        },
        contents,
        generationConfig: {
          temperature: 0.7,
        },
      }),
    }
  );

  if (!response.ok) {
    throw new Error("GEMINI_REQUEST_ERROR");
  }

  const data = await response.json();
  const answer = data?.candidates?.[0]?.content?.parts
    ?.map((part: any) => part.text || "")
    .join("")
    .trim();

  if (!answer) {
    throw new Error("GEMINI_EMPTY_RESPONSE");
  }

  return answer;
}

// Pilih AI dan jalankan fallback
let assistantReply = "";
let aiProvider = "";

try {
  if (openaiKey) {
    assistantReply = await callOpenAI();
    aiProvider = "openai";
  } else {
    throw new Error("OPENAI_NOT_CONFIGURED");
  }
} catch (error) {
  const errorMessage =
    error instanceof Error ? error.message : "";

  const canFallback = [
    "OPENAI_NOT_CONFIGURED",
    "OPENAI_TEMPORARY_ERROR",
  ].includes(errorMessage);

  if (!canFallback) {
    throw error;
  }

  if (!geminiKey) {
    throw new Error("AI_SERVICES_UNAVAILABLE");
  }

  assistantReply = await callGemini();
  aiProvider = "gemini";
}

console.log("AI provider used:", aiProvider);

// Gunakan assistantReply sebagai jawaban AI.
// Lanjutkan proses penyimpanan pesan assistant
// menggunakan mekanisme penyimpanan yang sudah ada.


    // ─── 9. Save assistant message ─────────────────────────────
    await adminClient
      .from("ai_messages")
      .insert({
        conversation_id: convId,
        user_id: user.id,
        role: "assistant",
        content: reply,
      });

    // Update conversation timestamp
    await adminClient
      .from("ai_conversations")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", convId);

    return new Response(
      JSON.stringify({ reply, conversationId: convId }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("Edge function error:", err);
    return new Response(
      JSON.stringify({ error: "Terjadi kesalahan sistem. Silakan coba lagi." }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
