"use client";
import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import AppHeader from "../components/app-header";
import InvoiceModal from "./invoice-modal";

type Invoice = {
  _id: Id<"invoices">;
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
    <div className="min-h-screen bg-zinc-950 text-white">
      <AppHeader />
      <main className="max-w-5xl mx-auto px-8 py-12">
        <div className="flex items-center justify-between mb-8">
          <h1 className="text-3xl font-bold">Invoices</h1>
          <button
            onClick={() => setModal("add")}
            className="rounded-lg bg-white text-black text-sm font-semibold px-4 py-2 hover:bg-zinc-200 transition-colors"
          >
            + New Invoice
          </button>
        </div>

        <div className="rounded-xl border border-zinc-800 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-800 bg-zinc-900 text-zinc-400 uppercase text-xs tracking-wider">
                <th className="text-left px-6 py-3">Member</th>
                <th className="text-left px-6 py-3">Amount</th>
                <th className="text-left px-6 py-3">Status</th>
                <th className="text-left px-6 py-3">Due Date</th>
                <th className="px-6 py-3" />
              </tr>
            </thead>
            <tbody>
              {invoices === undefined ? (
                <tr><td colSpan={5} className="px-6 py-8 text-center text-zinc-500">Loading...</td></tr>
              ) : invoices.length === 0 ? (
                <tr><td colSpan={5} className="px-6 py-8 text-center text-zinc-500">No invoices yet.</td></tr>
              ) : (
                (invoices as Invoice[]).map((inv) => (
                  <tr key={inv._id} className="border-b border-zinc-800 last:border-0 hover:bg-zinc-900 transition-colors">
                    <td className="px-6 py-4 font-medium">{inv.memberName}</td>
                    <td className="px-6 py-4 text-zinc-400">${inv.amount.toFixed(2)}</td>
                    <td className="px-6 py-4">
                      <span className={`inline-block px-2.5 py-0.5 rounded-full text-xs font-semibold ${
                        inv.status === "paid"
                          ? "bg-green-900 text-green-400"
                          : "bg-yellow-900 text-yellow-400"
                      }`}>
                        {inv.status}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-zinc-400">{inv.dueDate}</td>
                    <td className="px-6 py-4 flex gap-3 justify-end">
                      <button onClick={() => setModal(inv)} className="text-xs text-zinc-400 hover:text-white transition-colors">Edit</button>
                      <button onClick={() => handleDelete(inv._id)} className="text-xs text-red-500 hover:text-red-400 transition-colors">Delete</button>
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
