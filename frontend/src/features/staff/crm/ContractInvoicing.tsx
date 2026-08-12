import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  getPipeline, getContractTemplates, sendContract, sendRetainerInvoice, sendGmvInvoice, updateOpportunityStage,
  type Opportunity,
} from '@/lib/crmApi';

const CONTRACT_SIGNED_STAGE_ID = '246fa975-94b0-423a-8529-b07601609291';

function ContactSelect({ opps, value, onChange, placeholder }: { opps: Opportunity[]; value: string; onChange: (id: string) => void; placeholder: string }) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="h-8 flex-1 min-w-[160px] text-xs"><SelectValue placeholder={placeholder} /></SelectTrigger>
      <SelectContent>
        {opps.map((o) => (
          <SelectItem key={o.id} value={o.id}>{o.contact.name || o.name}{o.contact.email ? ` — ${o.contact.email}` : ''} ({o.stageName})</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * Contract + Invoicing — port of dashboard/segments.html's Contract row
 * (send GHL contract template, auto-sends the retainer invoice; separately
 * "Mark Signed") and GMV Performance Invoice row. Same three backend calls
 * (POST /api/ghl/send-contract, /send-retainer-invoice, /send-gmv-invoice),
 * same default-template-first sort for the template picker.
 */
export function ContractInvoicing() {
  const queryClient = useQueryClient();
  const pipelineQuery = useQuery({ queryKey: ['staff', 'crm', 'pipeline', 'growth-partners'], queryFn: () => getPipeline('growth-partners') });
  const templatesQuery = useQuery({ queryKey: ['staff', 'crm', 'contract-templates'], queryFn: getContractTemplates });
  const opps: Opportunity[] = pipelineQuery.data?.opportunities || [];

  const DEFAULT_TEMPLATE_ID = '69fbae875bceba21370ca11d';
  const sortedTemplates = useMemo(() => {
    const list = templatesQuery.data?.templates || [];
    return [...list].sort((a, b) => {
      if (a.id === DEFAULT_TEMPLATE_ID) return -1;
      if (b.id === DEFAULT_TEMPLATE_ID) return 1;
      return (b.published ? 1 : 0) - (a.published ? 1 : 0);
    });
  }, [templatesQuery.data]);

  // ── Contract row state ──
  const [contractOppId, setContractOppId] = useState('');
  const [retainerAmt, setRetainerAmt] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [sendingContract, setSendingContract] = useState(false);
  const [contractStatus, setContractStatus] = useState<{ text: string; ok: boolean } | null>(null);
  const [marking, setMarking] = useState(false);

  const contractOpp = opps.find((o) => o.id === contractOppId);

  async function handleSendContract() {
    if (!contractOpp) { setContractStatus({ text: 'Select a contact first', ok: false }); return; }
    const effectiveTemplateId = templateId || sortedTemplates[0]?.id;
    if (!effectiveTemplateId) { setContractStatus({ text: 'Select a contract template', ok: false }); return; }
    if (!retainerAmt.trim()) { setContractStatus({ text: 'Enter the monthly retainer amount so the invoice can be created', ok: false }); return; }

    setSendingContract(true);
    setContractStatus(null);
    try {
      await sendContract(effectiveTemplateId, contractOpp.contact.id);
      setContractStatus({ text: '✓ Contract sent. Sending retainer invoice…', ok: true });
      const inv = await sendRetainerInvoice({
        contactId: contractOpp.contact.id, retainerAmount: retainerAmt,
        contactName: contractOpp.contact.name, contactEmail: contractOpp.contact.email,
      });
      const fmtAmt = parseFloat(String(retainerAmt).replace(/[^0-9.]/g, '')).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
      setContractStatus({ text: `✓ Contract sent + ${fmtAmt} retainer invoice sent to ${contractOpp.contact.name || 'contact'}.`, ok: true });
      void inv;
    } catch (e) {
      setContractStatus({ text: '✗ ' + (e instanceof Error ? e.message : 'Send failed'), ok: false });
    } finally {
      setSendingContract(false);
    }
  }

  async function handleMarkSigned() {
    if (!contractOppId) return;
    setMarking(true);
    try {
      await updateOpportunityStage('growth-partners', contractOppId, CONTRACT_SIGNED_STAGE_ID);
      queryClient.invalidateQueries({ queryKey: ['staff', 'crm', 'pipeline', 'growth-partners'] });
    } finally {
      setMarking(false);
    }
  }

  // ── GMV invoice row state ──
  const [gmvOppId, setGmvOppId] = useState('');
  const [gmvAmount, setGmvAmount] = useState('');
  const [gmvPct, setGmvPct] = useState('');
  const [sendingGmv, setSendingGmv] = useState(false);
  const [gmvStatus, setGmvStatus] = useState<{ text: string; ok: boolean } | null>(null);

  const gmvOpp = opps.find((o) => o.id === gmvOppId);
  const gmvFeePreview = useMemo(() => {
    const gmvNum = parseFloat(gmvAmount);
    const pctNum = parseFloat(gmvPct);
    if (gmvNum > 0 && pctNum > 0) return `= ${((gmvNum * pctNum) / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })}`;
    return '';
  }, [gmvAmount, gmvPct]);

  async function handleSendGmvInvoice() {
    if (!gmvOpp) { setGmvStatus({ text: 'Select a contact first', ok: false }); return; }
    if (!gmvAmount.trim()) { setGmvStatus({ text: 'Enter the GMV amount for the month', ok: false }); return; }
    if (!gmvPct.trim()) { setGmvStatus({ text: 'Enter the GMV %', ok: false }); return; }

    const now = new Date();
    const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const month = prevMonth.toLocaleString('en-US', { month: 'long', year: 'numeric' });

    setSendingGmv(true);
    setGmvStatus(null);
    try {
      const d = await sendGmvInvoice({
        contactId: gmvOpp.contact.id, contactName: gmvOpp.contact.name, contactEmail: gmvOpp.contact.email,
        gmvAmount, gmvPercent: gmvPct, month,
      });
      const fee = d.fee.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
      const gmvFmt = d.gmv.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
      setGmvStatus({ text: `✓ GMV invoice sent — ${d.pct}% of ${gmvFmt} = ${fee} for ${month}.`, ok: true });
    } catch (e) {
      setGmvStatus({ text: '✗ ' + (e instanceof Error ? e.message : 'Send failed'), ok: false });
    } finally {
      setSendingGmv(false);
    }
  }

  return (
    <Card>
      <CardContent className="space-y-5 pt-6">
        {/* Contract row */}
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-[200px] flex-1">
            <p className="text-sm font-semibold">✍️ Contract</p>
            <p className="text-xs text-muted-foreground">Legally binding — send only when they've verbally agreed to move forward</p>
            <p className="mt-1 text-[0.68rem] text-muted-foreground opacity-70">↳ Retainer invoice auto-sends when contract is sent</p>
          </div>
          <div className="flex flex-1 min-w-[280px] flex-wrap items-center gap-2">
            <ContactSelect opps={opps} value={contractOppId} onChange={setContractOppId} placeholder="Select contact…" />
            <Input value={retainerAmt} onChange={(e) => setRetainerAmt(e.target.value)} placeholder="$/mo e.g. 1500" className="h-8 w-28 text-xs" />
            <Select value={templateId} onValueChange={setTemplateId}>
              <SelectTrigger className="h-8 min-w-[160px] flex-1 text-xs"><SelectValue placeholder={templatesQuery.isPending ? 'Loading…' : 'Select template…'} /></SelectTrigger>
              <SelectContent>
                {sortedTemplates.map((t) => <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>)}
              </SelectContent>
            </Select>
            <Button size="sm" onClick={handleSendContract} disabled={sendingContract}>{sendingContract ? '⏳ Sending…' : '📝 Send Contract + Invoice'}</Button>
            <Button size="sm" variant="outline" onClick={handleMarkSigned} disabled={marking || !contractOppId}>→ Mark Signed</Button>
          </div>
        </div>
        {contractStatus && <p className={`text-xs ${contractStatus.ok ? 'text-emerald-500' : 'text-destructive'}`}>{contractStatus.text}</p>}

        <div className="border-t" />

        {/* GMV invoice row */}
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-[200px] flex-1">
            <p className="text-sm font-semibold">📈 GMV Performance Invoice</p>
            <p className="text-xs text-muted-foreground">Send monthly — enter actual GMV, fee is calculated automatically</p>
          </div>
          <div className="flex flex-1 min-w-[280px] flex-wrap items-center gap-2">
            <ContactSelect opps={opps} value={gmvOppId} onChange={setGmvOppId} placeholder="Select contact…" />
            <Input value={gmvAmount} onChange={(e) => setGmvAmount(e.target.value)} placeholder="GMV e.g. 42000" className="h-8 w-28 text-xs" />
            <Input value={gmvPct} onChange={(e) => setGmvPct(e.target.value)} placeholder="% e.g. 5" className="h-8 w-20 text-xs" />
            {gmvFeePreview && <span className="whitespace-nowrap text-sm font-bold text-emerald-500">{gmvFeePreview}</span>}
            <Button size="sm" onClick={handleSendGmvInvoice} disabled={sendingGmv}>{sendingGmv ? '⏳ Sending…' : '📤 Send Invoice'}</Button>
          </div>
        </div>
        {gmvStatus && <p className={`text-xs ${gmvStatus.ok ? 'text-emerald-500' : 'text-destructive'}`}>{gmvStatus.text}</p>}
      </CardContent>
    </Card>
  );
}
