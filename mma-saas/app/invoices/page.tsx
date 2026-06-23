"use client";
import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import AppHeader from "../components/app-header";
import InvoiceModal from "./invoice-modal";

type Invoice = {
  _id: Id<"invoices">;
  memberId: Id<"members">;
  memberName: string;
  amount: number;
  status: "paid" | "unpaid";
  dueDate: string;
};

export default function InvoicesPage() {
  const invoices = useQuery(api.invoices.getAll);
  const remove = useMutation(api.invoices.remove);
  const [modal, setModal] = useState<null | "add" | Invoice>(null);

  async function handleDelete(id: Id<"invoices">) {
    if (!confirm("Delete this invoice?")) return;
    await remove({ id });
  }

  return (
    <div className="min-h-screen text-white" style={{ backgroundColor: "#0D0D0D" }}>
      <AppHeader />
      <main className="max-w-5xl mx-auto px-8 py-12">
        <div className="flex items-center justify-between mb-8">
          <h1 className="text-3xl" style={{ color: "#FFFFFF", fontWeight: 500 }}>Invoices</h1>
          <button
            onClick={() => setModal("add")}
            className="rounded-lg text-sm font-semibold px-4 py-2 transition-colors"
            style={{ backgroundColor: "#E02020", color: "#FFFFFF" }}
            onMouseEnter={e => (e.currentTarget.style.backgroundColor = "#B91C1C")}
            onMouseLeave={e => (e.currentTarget.style.backgroundColor = "#E02020")}
          >
            + New Invoice
          </button>
        </div>

        <div className="rounded-xl overflow-hidden" style={{ border: "1px solid #333333" }}>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs uppercase tracking-wider" style={{ borderBottom: "1px solid #333333", backgroundColor: "#1A1A1A", color: "#555555" }}>
                <th className="text-left px-6 py-3">Member</th>
                <th className="text-left px-6 py-3">Amount</th>
                <th className="text-left px-6 py-3">Status</th>
                <th className="text-left px-6 py-3">Due Date</th>
                <th className="px-6 py-3" />
              </tr>
            </thead>
            <tbody>
              {invoices === undefined ? (
                <tr><td colSpan={5} className="px-6 py-8 text-center" style={{ color: "#555555" }}>Loading...</td></tr>
              ) : invoices.length === 0 ? (
                <tr><td colSpan={5} className="px-6 py-8 text-center" style={{ color: "#555555" }}>No invoices yet.</td></tr>
              ) : (
                (invoices as Invoice[]).map((inv) => (
                  <tr
                    key={inv._id}
                    className="transition-colors"
                    style={{ borderBottom: "1px solid #333333" }}
                    onMouseEnter={e => (e.currentTarget.style.backgroundColor = "#1A1A1A")}
                    onMouseLeave={e => (e.currentTarget.style.backgroundColor = "transparent")}
                  >
                    <td className="px-6 py-4 font-medium" style={{ color: "#FFFFFF" }}>{inv.memberName}</td>
                    <td className="px-6 py-4" style={{ color: "#888888" }}>${inv.amount.toFixed(2)}</td>
                    <td className="px-6 py-4">
                      <span
                        className="inline-block px-2.5 py-0.5 rounded-full text-xs font-semibold"
                        style={
                          inv.status === "paid"
                            ? { backgroundColor: "#0A2A14", color: "#4ADE80" }
                            : { backgroundColor: "#2A1A00", color: "#FCD34D" }
                        }
                      >
                        {inv.status}
                      </span>
                    </td>
                    <td className="px-6 py-4" style={{ color: "#888888" }}>{inv.dueDate}</td>
                    <td className="px-6 py-4">
                      <div className="flex gap-3 justify-end">
                        <button
                          onClick={() => setModal(inv)}
                          className="text-xs transition-colors hover:text-white"
                          style={{ color: "#888888" }}
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => handleDelete(inv._id)}
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
        <InvoiceModal
          invoice={modal === "add" ? undefined : modal}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  );
}
