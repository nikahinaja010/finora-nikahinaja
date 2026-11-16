# Project memory

## Product intent & audience

- **Finora** — personal finance management web app with an AI Financial Consultant feature.
- Target audience: Indonesian individual users managing personal finances (income, expenses, budgets, debts, goals).
- Core value: combine practical financial tracking tools with an AI-powered consultant that gives personalized, educational financial guidance.

## Brand personality & voice

- Language: Indonesian (Bahasa Indonesia) throughout — UI labels, system prompts, disclaimers, error messages.
- Tone: helpful, educational, trustworthy; AI consultant framed as non-authoritative financial education (disclaimers included).
- AI consultant identity: structured responses with clear role, working principles, and answer format defined in system prompt.

## Visual design & UX direction

- Chat interface pattern: sidebar conversation history + main message area + auto-resize textarea input.
- AI chat UX: welcome screen with 4 clickable suggested questions, separate user/AI message bubbles with avatars, "Sedang berpikir…" loading indicator, optimistic UI with rollback on failure, auto-scroll to latest message.
- Data-sharing consent toggle in AI chat — when active, sends user financial profile + 10 recent transactions for personalized answers.
- Dashboard: stat cards, income-vs-expense charts, category breakdowns, recent transactions, financial health metrics, month filter.
- Placeholder pages show "Dalam Pengembangan" / "Segera Hadir" text.
- Error states include retry buttons ("Coba Lagi").

## Decisions, constraints & rationale

- **Stack**: Vite + React frontend, Supabase backend (auth, DB, edge functions), OpenAI API (gpt-4o-mini, max 800 tokens, temp 0.7).
- **AI Consultant architecture**:
  - Edge function `ai-consultant` at `supabase/functions/ai-consultant/index.ts`, registered in `config.toml`.
  - JWT auth required; rate limit 30 messages/day per user.
  - Auto-creates conversation from first message (title = message snippet); loads last 20 messages as context.
  - Graceful fallback when `OPENAI_API_KEY` unset — stores fallback message, returns `aiUnavailable: true`.
  - Full CORS headers on all responses.
- **Database**: tables `ai_conversations` and `ai_messages` with RLS (owner-scoped policies), indexes, auto-update trigger on `updated_at`, cascade delete on FK.
- **Auth**: Supabase auth with auto-create profile via DB trigger; pages for login, register, forgot/reset password.
- **Working features**: landing page, authentication, dashboard, transactions (CRUD), financial analysis (assessment form + reports + history).
- **Placeholder features**: Budget Planner, Debt Management, Financial Goals, Financial Reports — all show "Dalam Pengembangan". Settings page partially built (profile works, preferences "Segera Hadir").
- Project compiles and builds successfully with no errors.

## Open questions & assumptions

- **Edge function `ai-consultant` not yet deployed** to Supabase — deployment requires Supabase dashboard access or API keys.
- **`OPENAI_API_KEY` secret not configured** — without it AI always returns fallback; code handles this gracefully but real AI functionality is inactive.
- Both deployment steps require credentials/access not available from the development environment.
- No explicit `.bolt/prompt` instructions exist for this project; all context is inferred from codebase inspection.