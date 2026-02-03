import { Outlet, Link, useLocation, useNavigate } from 'react-router-dom';
import { useProjectStore } from '../store/project-store';

export default function Layout() {
  const location = useLocation();
  const navigate = useNavigate();
  const currentProject = useProjectStore(state => state.currentProject);

  const isProjectRoute = location.pathname.startsWith('/project/');

  return (
    <div className="flex h-screen bg-sentry-background">
      {/* Sidebar */}
      <div className="w-64 bg-sentry-gradient-dark text-white flex flex-col border-r border-sentry-border shadow-2xl">
        <div className="p-6 border-b border-sentry-border">
          <div className="flex items-center gap-3 mb-2">
            <div className="w-10 h-10 rounded-lg bg-sentry-gradient flex items-center justify-center text-2xl shadow-sentry">
              🔮
            </div>
            <div>
              <h1 className="text-xl font-bold text-gradient">SE Copilot</h1>
              <p className="text-xs text-gray-400">Demo Builder</p>
            </div>
          </div>
        </div>

        <nav className="flex-1 px-4 space-y-1 py-4">
          <NavLink to="/" active={location.pathname === '/'}>
            <span className="text-lg mr-2">🏠</span> Home
          </NavLink>
          <NavLink to="/new" active={location.pathname === '/new'}>
            <span className="text-lg mr-2">✨</span> New Project
          </NavLink>

          {currentProject && (
            <>
              <div className="pt-6 pb-2 text-xs font-semibold text-gray-500 uppercase tracking-wider">
                Current Project
              </div>
              <div className="text-sm text-white px-3 py-2.5 bg-sentry-gradient rounded-lg mb-2 font-medium shadow-sentry">
                <div className="flex items-center gap-2">
                  <span className="text-base">📁</span>
                  <span className="truncate">{currentProject.project.name}</span>
                </div>
              </div>
              <NavLink
                to={`/project/${currentProject.id}/plan`}
                active={location.pathname.includes('/plan')}
              >
                <span className="text-lg mr-2">📋</span> Planning
              </NavLink>
              <NavLink
                to={`/project/${currentProject.id}/generate`}
                active={location.pathname.includes('/generate')}
                disabled={currentProject.status === 'draft'}
              >
                <span className="text-lg mr-2">⚡</span> Generate
              </NavLink>
              <NavLink
                to={`/project/${currentProject.id}/refine`}
                active={location.pathname.includes('/refine')}
                disabled={currentProject.status !== 'generated' && currentProject.status !== 'published'}
              >
                <span className="text-lg mr-2">🔧</span> Refine
              </NavLink>
              <NavLink
                to={`/project/${currentProject.id}/data`}
                active={location.pathname.includes('/data')}
                disabled={currentProject.status !== 'generated' && currentProject.status !== 'published'}
              >
                <span className="text-lg mr-2">🎲</span> Run Data
              </NavLink>
              <NavLink
                to={`/project/${currentProject.id}/deploy`}
                active={location.pathname.includes('/deploy')}
                disabled={currentProject.status !== 'generated' && currentProject.status !== 'published'}
              >
                <span className="text-lg mr-2">🖥️</span> Deploy
              </NavLink>
              <NavLink
                to={`/project/${currentProject.id}/publish`}
                active={location.pathname.includes('/publish')}
                disabled={currentProject.status !== 'generated' && currentProject.status !== 'published'}
              >
                <span className="text-lg mr-2">🚀</span> Publish
              </NavLink>
            </>
          )}
        </nav>

        <div className="p-4 border-t border-sentry-border">
          <NavLink to="/settings" active={location.pathname === '/settings'}>
            <span className="text-lg mr-2">⚙️</span> Settings
          </NavLink>
        </div>
      </div>

      {/* Main content */}
      <div className="flex-1 overflow-auto">
        <Outlet />
      </div>
    </div>
  );
}

interface NavLinkProps {
  to: string;
  active: boolean;
  disabled?: boolean;
  children: React.ReactNode;
}

function NavLink({ to, active, disabled, children }: NavLinkProps) {
  const className = `
    flex items-center px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-200
    ${active
      ? 'bg-sentry-purple-500 text-white shadow-sentry'
      : 'text-gray-300 hover:bg-white/5 hover:text-white hover:translate-x-0.5'
    }
    ${disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}
  `;

  if (disabled) {
    return <div className={className}>{children}</div>;
  }

  return (
    <Link to={to} className={className}>
      {children}
    </Link>
  );
}
