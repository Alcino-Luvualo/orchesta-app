import React, { useEffect, useMemo, useState } from 'react'
import { Cpu, Plus, RefreshCw, Server, Shield, Terminal, Trash2 } from 'lucide-react'

type Tool = { id: string; name: string; cmd: string; description: string; installed: boolean; path: string }
type Environment = { id: string; name: string; kind: string; status: string; config?: { endpoint?: string }; updatedAt?: string }

export const EnvironmentsScreen: React.FC = () => {
  const [tools, setTools] = useState<Tool[]>([])
  const [environments, setEnvironments] = useState<Environment[]>([])
  const [showConnect, setShowConnect] = useState(false)
  const [kind, setKind] = useState('ssh')
  const [endpoint, setEndpoint] = useState('')
  const [name, setName] = useState('')
  const [message, setMessage] = useState<string | null>(null)
  const [execOutput, setExecOutput] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)

  const load = async () => {
    try {
      const [detected, stored] = await Promise.all([
        window.orchestra?.detectTools?.(),
        window.orchestra?.invoke('environments.list')
      ])
      setTools(Array.isArray(detected) ? detected : [])
      setEnvironments(Array.isArray(stored) ? stored as Environment[] : [])
      setMessage(null)
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : 'Não foi possível carregar os ambientes')
    }
  }

  useEffect(() => { void load() }, [])

  const installed = (id: string) => tools.find((tool) => tool.id === id)
  const configured = useMemo(() => new Set(environments.map((environment) => environment.kind)), [environments])

  const saveEnvironment = async () => {
    if (!endpoint.trim() && kind !== 'local') {
      setMessage('Indica um endpoint para o ambiente.')
      return
    }
    setBusy(true)
    try {
      const probe = await window.orchestra?.invoke('environment.probe', { kind, endpoint: endpoint.trim() }) as { available?: boolean; detail?: string }
      const environment: Environment = {
        id: `env_${crypto.randomUUID()}`,
        name: name.trim() || endpoint.trim() || `${kind} environment`,
        kind,
        status: probe?.available ? 'available' : 'unavailable',
        config: { endpoint: endpoint.trim() }
      }
      await window.orchestra?.invoke('environments.save', { environment })
      setName('')
      setEndpoint('')
      setShowConnect(false)
      setMessage(probe?.available ? 'Ambiente verificado e guardado.' : `Guardado, mas indisponível: ${probe?.detail || 'sem diagnóstico'}`)
      await load()
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : 'Não foi possível guardar o ambiente')
    } finally {
      setBusy(false)
    }
  }

  const removeEnvironment = async (id: string) => {
    try {
      await window.orchestra?.invoke('environments.delete', { id })
      setEnvironments((current) => current.filter((environment) => environment.id !== id))
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : 'Não foi possível remover o ambiente')
    }
  }

  const testEnvironment = async (environment: Environment) => {
    setBusy(true)
    try {
      const result = await window.orchestra?.invoke('environment.exec', { environmentId: environment.id, argv: ['printf', 'orchestra-ready\\n'], timeoutMs: 15000 }) as { stdout?: string; stderr?: string; exitCode?: number | null; timedOut?: boolean }
      const output = result?.timedOut ? 'timeout' : `${result?.stdout || result?.stderr || ''} (exit ${result?.exitCode ?? '—'})`
      setExecOutput((current) => ({ ...current, [environment.id]: output.trim() }))
      setMessage(null)
    } catch (reason) { setMessage(reason instanceof Error ? reason.message : 'Não foi possível executar no ambiente') }
    finally { setBusy(false) }
  }

  const cards = [
    { id: 'local', title: 'Host local', description: 'Shell nativo POSIX do daemon', icon: <Terminal className="icon" />, status: 'available', detail: 'Ativo' },
    ...(['docker', 'podman', 'ssh'] as const).map((id) => ({
      id,
      title: id === 'ssh' ? 'OpenSSH' : id[0].toUpperCase() + id.slice(1),
      description: id === 'ssh' ? 'Bridge remoto validado pelo daemon' : 'Runtime de containers local',
      icon: id === 'ssh' ? <Shield className="icon" /> : id === 'docker' ? <Cpu className="icon" /> : <Server className="icon" />,
      status: installed(id)?.installed ? 'available' : 'unavailable',
      detail: installed(id)?.installed ? installed(id)?.path : 'Binário não encontrado'
    }))
  ]

  return <div className="panel-screen">
    <div className="page-head">
      <div><h1>Ambientes de Execução</h1><p>Estado real das ferramentas locais e dos bridges persistidos no daemon.</p></div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="btn" onClick={() => void load()}><RefreshCw className="icon" /> Atualizar</button>
        <button className="btn primary" onClick={() => setShowConnect(!showConnect)}><Plus className="icon" /> Conectar ambiente</button>
      </div>
    </div>
    {message && <div className="empty-state error" role="status">{message}</div>}
    {showConnect && <div className="environment-connect">
      <b>Adicionar ambiente</b>
      <input placeholder="Nome (opcional)" value={name} onChange={(event) => setName(event.target.value)} />
      <select value={kind} onChange={(event) => setKind(event.target.value)}><option value="ssh">SSH</option><option value="docker">Docker</option><option value="podman">Podman</option><option value="local">Local</option></select>
      <input placeholder={kind === 'ssh' ? 'Host ou alias SSH' : 'Endpoint/contexto (opcional)'} value={endpoint} onChange={(event) => setEndpoint(event.target.value)} />
      <button className="btn primary" disabled={busy} onClick={() => void saveEnvironment()}>{busy ? 'A verificar…' : 'Guardar e verificar'}</button>
    </div>}
    <div className="env-grid">
      {cards.map((environment) => <div className="env-card" key={environment.id}>
        <div className="env-top"><div className="node-icon">{environment.icon}</div><div className={`status ${environment.status !== 'available' ? 'wait' : ''}`} /></div>
        <h3>{environment.title}</h3><p>{environment.description}</p>
        <div className="stats"><span>Estado: <b>{environment.detail}</b></span>{environment.id !== 'local' && <span>Configurado: <b>{configured.has(environment.id) ? 'sim' : 'não'}</b></span>}</div>
      </div>)}
      {environments.map((environment) => <div className="env-card" key={environment.id}>
        <div className="env-top"><div className="node-icon"><Server className="icon" /></div><button className="icon-btn" title="Remover ambiente" onClick={() => void removeEnvironment(environment.id)}><Trash2 className="icon" /></button></div>
        <h3>{environment.name}</h3><p>{environment.kind} · {environment.config?.endpoint || 'sem endpoint'}</p>
        <div className="stats"><span>Estado: <b>{environment.status}</b></span><span>Atualizado: <b>{environment.updatedAt ? new Date(environment.updatedAt).toLocaleString() : '—'}</b></span></div>
        <button className="btn" style={{ marginTop: 10, height: 27, fontSize: 9 }} disabled={busy} onClick={() => void testEnvironment(environment)}><Terminal className="icon" /> Testar execução</button>
        {execOutput[environment.id] && <code style={{ display: 'block', marginTop: 7, color: 'var(--primary)', fontSize: 9 }}>{execOutput[environment.id]}</code>}
      </div>)}
    </div>
  </div>
}
