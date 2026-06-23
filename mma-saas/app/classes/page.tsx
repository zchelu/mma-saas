"use client";
import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { useRouter } from "next/navigation";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import AppHeader from "../components/app-header";
import ClassModal from "./class-modal";

type GymClass = {
  _id: Id<"classes">;
  name: string;
  instructor: string;
  dayOfWeek: string;
  time: string;
};

export default function ClassesPage() {
  const classes = useQuery(api.classes.getAll);
  const enrollmentCounts = useQuery(api.enrollments.getEnrollmentCounts);
  const remove = useMutation(api.classes.remove);
  const [modal, setModal] = useState<null | "add" | GymClass>(null);
  const router = useRouter();

  async function handleDelete(id: Id<"classes">) {
    if (!confirm("Delete this class?")) return;
    await remove({ id });
  }

  return (
    <div className="min-h-screen text-white" style={{ backgroundColor: "#0D0D0D" }}>
      <AppHeader />
      <main className="max-w-5xl mx-auto px-8 py-12">
        <div className="flex items-center justify-between mb-8">
          <h1 className="text-3xl" style={{ color: "#FFFFFF", fontWeight: 500 }}>Classes</h1>
          <button
            onClick={() => setModal("add")}
            className="rounded-lg text-sm font-semibold px-4 py-2 transition-colors"
            style={{ backgroundColor: "#E02020", color: "#FFFFFF" }}
            onMouseEnter={e => (e.currentTarget.style.backgroundColor = "#B91C1C")}
            onMouseLeave={e => (e.currentTarget.style.backgroundColor = "#E02020")}
          >
            + Add Class
          </button>
        </div>

        <div className="rounded-xl overflow-hidden" style={{ border: "1px solid #333333" }}>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs uppercase tracking-wider" style={{ borderBottom: "1px solid #333333", backgroundColor: "#1A1A1A", color: "#555555" }}>
                <th className="text-left px-6 py-3">Class</th>
                <th className="text-left px-6 py-3">Instructor</th>
                <th className="text-left px-6 py-3">Day</th>
                <th className="text-left px-6 py-3">Time</th>
                <th className="text-left px-6 py-3">Enrolled</th>
                <th className="px-6 py-3" />
              </tr>
            </thead>
            <tbody>
              {classes === undefined ? (
                <tr><td colSpan={6} className="px-6 py-8 text-center" style={{ color: "#555555" }}>Loading...</td></tr>
              ) : classes.length === 0 ? (
                <tr><td colSpan={6} className="px-6 py-8 text-center" style={{ color: "#555555" }}>No classes yet.</td></tr>
              ) : (
                (classes as GymClass[]).map((c) => (
                  <tr
                    key={c._id}
                    className="transition-colors"
                    style={{ borderBottom: "1px solid #333333" }}
                    onMouseEnter={e => (e.currentTarget.style.backgroundColor = "#1A1A1A")}
                    onMouseLeave={e => (e.currentTarget.style.backgroundColor = "transparent")}
                  >
                    <td className="px-6 py-4 font-medium" style={{ color: "#FFFFFF" }}>{c.name}</td>
                    <td className="px-6 py-4" style={{ color: "#888888" }}>{c.instructor}</td>
                    <td className="px-6 py-4" style={{ color: "#888888" }}>{c.dayOfWeek}</td>
                    <td className="px-6 py-4" style={{ color: "#888888" }}>{c.time}</td>
                    <td className="px-6 py-4" style={{ color: "#888888" }}>
                      {enrollmentCounts ? (enrollmentCounts[c._id] ?? 0) : "—"}
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex gap-3 justify-end">
                        <button
                          onClick={() => router.push(`/classes/${c._id}`)}
                          className="text-xs transition-colors"
                          style={{ color: "#3B82F6" }}
                          onMouseEnter={e => (e.currentTarget.style.color = "#93C5FD")}
                          onMouseLeave={e => (e.currentTarget.style.color = "#3B82F6")}
                        >
                          Manage
                        </button>
                        <button
                          onClick={() => setModal(c)}
                          className="text-xs transition-colors hover:text-white"
                          style={{ color: "#888888" }}
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => handleDelete(c._id)}
                          className="text-xs transition-colors"
                          style={{ color: "#F87171" }}
                          onMouseEnter={e => (e.currentTarget.style.color = "#FCA5A5")}
                          onMouseLeave={e => (e.currentTarget.style.color = "#F87171")}
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </main>

      {modal !== null && (
        <ClassModal
          gymClass={modal === "add" ? undefined : modal}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  );
}
