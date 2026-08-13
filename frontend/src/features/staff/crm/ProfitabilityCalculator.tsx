import { useMemo, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const fmt = (n: number) => (n < 0 ? `-$${Math.abs(n).toFixed(2)}` : `$${n.toFixed(2)}`);
const fmtK = (n: number) => (Math.abs(n) >= 1000 ? `${n < 0 ? '-$' : '$'}${(Math.abs(n) / 1000).toFixed(1)}k` : fmt(n));
const colorClass = (n: number) => (n >= 0 ? 'text-emerald-500' : 'text-red-500');

interface Field { id: string; label: string; value: number; step: number; min: number; max?: number; }

/**
 * TikTok Shop Profitability Calculator — direct port of updateProfit() from
 * dashboard/segments.html. Pure client-side math, no backend, no state
 * persisted anywhere (matches the original — it always starts from the
 * same defaults on load).
 */
export function ProfitabilityCalculator() {
  const [price, setPrice] = useState(39.99);
  const [cogs, setCogs] = useState(8.0);
  const [shipping, setShipping] = useState(4.5);
  const [feePct, setFeePct] = useState(6);
  const [commPct, setCommPct] = useState(10);
  const [orders, setOrders] = useState(500);

  const { profitPerOrder, marginPct, monthlyProfit, monthlyGMV } = useMemo(() => {
    const platformFee = price * (feePct / 100);
    const creatorComm = price * (commPct / 100);
    const netRevenue = price - platformFee - creatorComm;
    const profitPerOrder = netRevenue - cogs - shipping;
    const marginPct = price > 0 ? (profitPerOrder / price) * 100 : 0;
    const monthlyProfit = profitPerOrder * orders;
    const monthlyGMV = price * orders;
    return { profitPerOrder, marginPct, monthlyProfit, monthlyGMV };
  }, [price, cogs, shipping, feePct, commPct, orders]);

  const fields: (Field & { onChange: (n: number) => void })[] = [
    { id: 'price', label: 'Sale Price', value: price, step: 0.01, min: 1, onChange: setPrice },
    { id: 'cogs', label: 'COGS', value: cogs, step: 0.01, min: 0, onChange: setCogs },
    { id: 'shipping', label: 'Shipping', value: shipping, step: 0.01, min: 0, onChange: setShipping },
    { id: 'fee', label: 'TikTok Fee %', value: feePct, step: 0.5, min: 0, max: 30, onChange: setFeePct },
    { id: 'comm', label: 'Creator Comm %', value: commPct, step: 0.5, min: 0, max: 50, onChange: setCommPct },
    { id: 'orders', label: 'Monthly Orders', value: orders, step: 1, min: 1, onChange: setOrders },
  ];

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base">📊 TikTok Profitability</CardTitle>
        <a href="https://cultcontent.cc/profitability-calculator" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
          Full tool <ExternalLink className="size-3" />
        </a>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {fields.map((f) => (
            <div key={f.id}>
              <Label className="text-[0.65rem] uppercase tracking-wide text-muted-foreground">{f.label}</Label>
              <Input
                type="number" value={f.value} min={f.min} max={f.max} step={f.step}
                onChange={(e) => f.onChange(Number(e.target.value))}
                className="h-8 text-sm"
              />
            </div>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-3 rounded-md border bg-muted/30 p-3">
          <div>
            <p className="text-[0.65rem] font-semibold uppercase tracking-wide text-muted-foreground">Profit / Order</p>
            <p className={`mt-0.5 text-xl font-extrabold ${colorClass(profitPerOrder)}`}>{fmt(profitPerOrder)}</p>
          </div>
          <div>
            <p className="text-[0.65rem] font-semibold uppercase tracking-wide text-muted-foreground">Margin</p>
            <p className={`mt-0.5 text-xl font-extrabold ${colorClass(marginPct)}`}>{marginPct.toFixed(1)}%</p>
          </div>
          <div>
            <p className="text-[0.65rem] font-semibold uppercase tracking-wide text-muted-foreground">Monthly Profit</p>
            <p className={`mt-0.5 text-xl font-extrabold ${colorClass(monthlyProfit)}`}>{fmtK(monthlyProfit)}</p>
          </div>
          <div>
            <p className="text-[0.65rem] font-semibold uppercase tracking-wide text-muted-foreground">Monthly GMV</p>
            <p className="mt-0.5 text-xl font-extrabold">{fmtK(monthlyGMV)}</p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
