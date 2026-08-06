import React from 'react'
import { Cpu, Terminal, Server, Shield, Plus, CheckCircle } from 'lucide-react'

export const EnvironmentsScreen: React.FC = () => {
  return (
    <div className="panel-screen">
      <div className="page-head">
        <div>
          <h1>Ambientes de Execução</h1>
          <p>Configura o isolamento de terminais em ambientes Locais, Docker, Podman ou SSH.</p>
        </div>
        <button className="btn primary" onClick={() => alert('Adicionar novo ambiente')}>
          <Plus className="icon" /> Conectar Ambiente
        </button>
      </div>

      <div className="env-grid">
        <div className="env-card">
          <div className="env-top">
            <div className="node-icon"><Terminal className="icon" /></div>
            <div className="status" />
          </div>
          <h3>Host Linux Local</h3>
          <p>Shell nativo POSIX (/bin/bash, /bin/zsh)</p>
          <div className="stats">
            <span>Status: <b>Ativo</b></span>
            <span>PTYs: <b>2 conexões</b></span>
          </div>
        </div>

        <div className="env-card">
          <div className="env-top">
            <div className="node-icon" style={{ color: 'var(--info)' }}><Cpu className="icon" /></div>
            <div className="status" />
          </div>
          <h3>Docker Engine</h3>
          <p>Docker CLI local (/var/run/docker.sock)</p>
          <div className="stats">
            <span>Status: <b>Disponível</b></span>
            <span>Containers: <b>1 rodando</b></span>
          </div>
        </div>

        <div className="env-card">
          <div className="env-top">
            <div className="node-icon" style={{ color: 'var(--purple)' }}><Server className="icon" /></div>
            <div className="status wait" />
          </div>
          <h3>SSH Remote Host</h3>
          <p>Conexão remota via OpenSSH</p>
          <div className="stats">
            <span>Status: <b>Configurável</b></span>
          </div>
        </div>
      </div>
    </div>
  )
}
