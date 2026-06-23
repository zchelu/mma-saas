"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function SetupPage() {
  const router = useRouter();
  const [mode, setMode] = useState<"phone" | "email">("phone");
  const [form, setForm] = useState({ firstName: "", lastName: "", phone: "", email: "" });

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    setForm({ ...form, [e.target.name]: e.target.value });
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    router.push("/sign-up");
  }

  const contact = mode === "phone" ? form.phone : form.email;
  const ready = form.firstName && form.lastName && contact;

  return (
    <div className="min-h-screen bg-zinc-950 text-white flex flex-col items-center justify-center px-6">
      <div className="w-full max-w-sm">
        <h1 className="text-2xl font-extrabold tracking-tight mb-1">Set up your gym</h1>
        <p className="text-sm text-zinc-400 mb-8">Just a few details to get started.</p>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="flex gap-3">
            <div className="flex-1 flex flex-col gap-1">
              <label className="text-xs text-zinc-400 font-medium">First name</label>
              <input
                name="firstName"
                value={form.firstName}
                onChange={handleChange}
                autoComplete="given-name"
                className="bg-zinc-900 border border-zinc-700 rounded-lg px-4 py-3 text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-zinc-500"
                placeholder="John"
              />
            </div>
            <div className="flex-1 flex flex-col gap-1">
              <label className="text-xs text-zinc-400 font-medium">Last name</label>
              <input
                name="lastName"
                value={form.lastName}
                onChange={handleChange}
                autoComplete="family-name"
                className="bg-zinc-900 border border-zinc-700 rounded-lg px-4 py-3 text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-zinc-500"
                placeholder="Smith"
              />
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setMode("phone")}
                className={`text-xs font-medium px-3 py-1 rounded-full border transition-colors ${
                  mode === "phone"
                    ? "bg-white text-black border-white"
                    : "bg-transparent text-zinc-400 border-zinc-700 hover:border-zinc-500"
                }`}
              >
                Phone
              </button>
              <button
                type="button"
                onClick={() => setMode("email")}
                className={`text-xs font-medium px-3 py-1 rounded-full border transition-colors ${
                  mode === "email"
                    ? "bg-white text-black border-white"
                    : "bg-transparent text-zinc-400 border-zinc-700 hover:border-zinc-500"
                }`}
              >
                Email
              </button>
            </div>

            {mode === "phone" ? (
              <input
                name="phone"
                value={form.phone}
                onChange={handleChange}
                type="tel"
                autoComplete="tel"
                className="bg-zinc-900 border border-zinc-700 rounded-lg px-4 py-3 text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-zinc-500"
                placeholder="(720) 555-0100"
              />
            ) : (
              <input
                name="email"
                value={form.email}
                onChange={handleChange}
                type="email"
                autoComplete="email"
                className="bg-zinc-900 border border-zinc-700 rounded-lg px-4 py-3 text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-zinc-500"
                placeholder="john@example.com"
              />
            )}
          </div>

          <button
            type="submit"
            disabled={!ready}
            className="mt-2 rounded-lg bg-white text-black font-semibold px-6 py-3 hover:bg-zinc-200 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Continue
          </button>
        </form>
      </div>
    </div>
  );
}
