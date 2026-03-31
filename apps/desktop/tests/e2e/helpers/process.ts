import { spawn, ChildProcess } from 'child_process'
import path from 'path'

interface ServerHandle {
  proc: ChildProcess
  stop: () => Promise<void>
}

export async function startDevServer(appPath: string, port: number, env: Record<string, string> = {}): Promise<ServerHandle> {
  return new Promise((resolve, reject) => {
    const proc = spawn('npm', ['run', 'dev'], {
      cwd: appPath,
      env: { ...process.env, PORT: String(port), ...env },
      stdio: 'pipe',
    })

    const timeout = setTimeout(() => reject(new Error(`Server at ${appPath} did not start within 30s`)), 30000)
    let started = false

    proc.stdout?.on('data', (data: Buffer) => {
      const line = data.toString()
      if (!started && (line.includes('ready') || line.includes('listening') || line.includes(`:${port}`))) {
        started = true
        clearTimeout(timeout)
        resolve({
          proc,
          stop: () => new Promise(r => { proc.kill('SIGTERM'); proc.on('exit', () => r(undefined)) }),
        })
      }
    })

    proc.on('error', (err) => { clearTimeout(timeout); reject(err) })
    proc.on('exit', (code) => {
      if (!started) { clearTimeout(timeout); reject(new Error(`Server exited early with code ${code}`)) }
    })
  })
}

export function waitForPort(port: number, timeoutMs = 20000): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs
    const check = () => {
      const net = require('net')
      const socket = new net.Socket()
      socket.setTimeout(1000)
      socket.on('connect', () => { socket.destroy(); resolve() })
      socket.on('error', () => {
        socket.destroy()
        if (Date.now() < deadline) setTimeout(check, 500)
        else reject(new Error(`Port ${port} not available after ${timeoutMs}ms`))
      })
      socket.connect(port, '127.0.0.1')
    }
    check()
  })
}
