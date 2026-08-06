import React, { useState } from 'react'
import { Clock, Plus, Play, CheckCircle } from 'lucide-react'

export const RoutinesScreen: React.FC = () => {
  const [routines, setRoutines] = useState([
    {
      id: 'r1',
      name: 'Auditoria Noturna de Segurança',
      schedule: '0 2 * * *',
      target: 'Code Reviewer',
      prompt: 'Executar cargo audit e verificar dependências desatualizadas',
      active: true,
      lastRun: 'Hoje às 02:00'
    },
    {
      id: 'r2',
      name: 'Build & Testes de Integração',
      schedule: '0 */4 * * *',
      target: 'Claude Code',
      prompt: 'Rodar npm test e verificar se o build do Electron compila sem erros',
      active: true,
      lastRun: 'Há 1 hora'
    }
  ])

  return (
    <div className="panel-screen">
      <div className="page-head">
        <div>
          <h1>Routines & Automações Agendadas</h1>
          <p>Cria e acompanha execuções automáticas de agentes com agendamentos Cron.</p>
        </div>
        <button className="btn primary" onClick={() => alert('Criar nova Routine')}>
          <Plus className="icon" /> Nova Routine
        </button>
      </div>

      <div style={{ display: 'grid', gap: 12, maxWidth: 800 }}>
        {routines.map((r) => (
          <div key={r.id} style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 10, padding: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Clock className="icon" style={{ color: 'var(--info)' }} />
                <b style={{ fontSize: 14 }}>{r.name}</b>
              </div>
              <button className="btn primary" style={{ height: 28, fontSize: 9 }} onClick={() => alert(`Routine "${r.name}" executada!`)}>
                <Play className="icon" style={{ width: 12, height: 12 }} /> Executar Agora
              </button>
            </div>

            <div style={{ marginTop: 8, fontSize: 10, color: 'var(--muted)' }}>
              <div>Agendamento Cron: <code style={{ color: 'var(--primary)' }}>{r.schedule}</code> · Agente: <b>{r.target}</b></div>
              <div style={{ background: 'var(--panel2)', padding: 8, borderRadius: 6, marginTop: 6, font: '10px var(--mono)' }}>
                {r.prompt}
              </div>
              <div style={{ marginTop: 8, color: 'var(--dim)', fontSize: 9 }}>Última execução: {r.lastRun}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
