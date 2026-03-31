import { Outlet, Link, useLocation } from 'react-router-dom';
import {
  Home, Plus, FileText, Zap, Wrench, Play, Terminal, Upload, Activity, Settings,
  CheckCircle2, FlaskConical
} from 'lucide-react';
import { useProjectStore } from '../store/project-store';

const STATUS_ORDER = ['draft', 'planning', 'locked', 'generated', 'published'];
const STATUS_COLORS: Record<string, string> = {
  draft: 'bg-white/30',
  planning: 'bg-blue-400',
  locked: 'bg-yellow-400',
  generated: 'bg-green-400',
  published: 'bg-sentry-purple-400',
};

function statusAtLeast(current: string, required: string) {
  return STATUS_ORDER.indexOf(current) >= STATUS_ORDER.indexOf(required);
}

export default function Layout() {
  const location = useLocation();
  const currentProject = useProjectStore(state => state.currentProject);

  return (
    <div className="flex h-screen bg-sentry-background">
      {/* Sidebar */}
      <div className="w-52 bg-sentry-gradient-dark text-white flex flex-col border-r border-sentry-border shrink-0">
        {/* Brand */}
        <div className="px-4 py-5 border-b border-sentry-border">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-md bg-sentry-gradient flex items-center justify-center text-base shadow-sentry shrink-0">
              🐾
            </div>
            <div>
              <div className="text-sm font-semibold text-gradient leading-none">Pawprint</div>
              <div className="text-[10px] text-white/35 mt-0.5">Leave a trace everywhere</div>
            </div>
          </div>
        </div>

        {/* Nav */}
        <nav className="flex-1 px-3 py-3 space-y-0.5 overflow-y-auto">
          <NavItem to="/" active={location.pathname === '/'} icon={<Home size={15} />}>
            Home
          </NavItem>
          <NavItem to="/new" active={location.pathname === '/new'} icon={<Plus size={15} />}>
            New Project
          </NavItem>

          {currentProject && (
            <>
              <div className="pt-4 pb-1.5 px-2 flex items-center gap-2">
                <span className="text-[10px] font-semibold text-white/35 uppercase tracking-widest">Project</span>
              </div>

              {/* Project name + status dot */}
              <div className="flex items-center gap-2 px-2 py-1.5 mb-1">
                <span className={`w-2 h-2 rounded-full shrink-0 ${STATUS_COLORS[currentProject.status] || 'bg-white/30'}`} />
                <span className="text-xs text-white/70 truncate font-medium">{currentProject.project.name}</span>
              </div>

              <NavItem
                to={`/project/${currentProject.id}/plan`}
                active={location.pathname.includes('/plan')}
                icon={<FileText size={15} />}
                done={statusAtLeast(currentProject.status, 'locked')}
              >
                Planning
              </NavItem>
              <NavItem
                to={`/project/${currentProject.id}/generate`}
                active={location.pathname.includes('/generate')}
                icon={<Zap size={15} />}
                disabled={!statusAtLeast(currentProject.status, 'planning')}
                done={statusAtLeast(currentProject.status, 'generated')}
                disabledHint="Complete Planning first"
              >
                Generate
              </NavItem>
              <NavItem
                to={`/project/${currentProject.id}/refine`}
                active={location.pathname.includes('/refine')}
                icon={<Wrench size={15} />}
                disabled={!statusAtLeast(currentProject.status, 'generated')}
                disabledHint="Generate first"
              >
                Refine
              </NavItem>
              <NavItem
                to={`/project/${currentProject.id}/data`}
                active={location.pathname.includes('/data')}
                icon={<Play size={15} />}
                disabled={!statusAtLeast(currentProject.status, 'generated')}
                disabledHint="Generate first"
              >
                Run Data
              </NavItem>
              <NavItem
                to={`/project/${currentProject.id}/deploy`}
                active={location.pathname.includes('/deploy')}
                icon={<Terminal size={15} />}
                disabled={!statusAtLeast(currentProject.status, 'generated')}
                disabledHint="Generate first"
              >
                Deploy
              </NavItem>
              <NavItem
                to={`/project/${currentProject.id}/publish`}
                active={location.pathname.includes('/publish')}
                icon={<Upload size={15} />}
                disabled={!statusAtLeast(currentProject.status, 'generated')}
                disabledHint="Generate first"
              >
                Publish
              </NavItem>
              <NavItem
                to={`/project/${currentProject.id}/trace-health`}
                active={location.pathname.includes('/trace-health')}
                icon={<Activity size={15} />}
                disabled={!statusAtLeast(currentProject.status, 'generated')}
                disabledHint="Generate first"
              >
                Trace Health
              </NavItem>
            </>
          )}
        </nav>

        <div className="px-3 py-3 border-t border-sentry-border space-y-0.5">
          <NavItem to="/training" active={location.pathname.startsWith('/training')} icon={<FlaskConical size={15} />}>
            Training
          </NavItem>
          <NavItem to="/settings" active={location.pathname === '/settings'} icon={<Settings size={15} />}>
            Settings
          </NavItem>
        </div>
      </div>

      {/* Main content */}
      <div className="flex-1 overflow-auto">
        <Outlet />
      </div>
    </div>
  );
}

interface NavItemProps {
  to: string;
  active: boolean;
  icon: React.ReactNode;
  disabled?: boolean;
  done?: boolean;
  disabledHint?: string;
  children: React.ReactNode;
}

function NavItem({ to, active, icon, disabled, done, disabledHint, children }: NavItemProps) {
  const base = `
    flex items-center justify-between w-full px-2.5 py-2 rounded-md text-[13px] font-medium transition-all duration-150
    ${active
      ? 'bg-sentry-purple-500 text-white shadow-sentry'
      : disabled
        ? 'text-white/30 cursor-not-allowed'
        : 'text-white/65 hover:bg-white/6 hover:text-white'
    }
  `;

  const inner = (
    <>
      <span className="flex items-center gap-2">
        <span className="shrink-0">{icon}</span>
        {children}
      </span>
      {done && !active && (
        <CheckCircle2 size={13} className="text-green-400 shrink-0" />
      )}
    </>
  );

  if (disabled) {
    return (
      <div className={base} title={disabledHint}>
        {inner}
      </div>
    );
  }

  return (
    <Link to={to} className={base}>
      {inner}
    </Link>
  );
}
