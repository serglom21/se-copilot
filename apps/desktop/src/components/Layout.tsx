import { Outlet, Link, useLocation, useNavigate } from 'react-router-dom';
import { useProjectStore } from '../store/project-store';

export default function Layout() {
  const location = useLocation();
  const navigate = useNavigate();
  const currentProject = useProjectStore(state => state.currentProject);

  const isProjectRoute = location.pathname.startsWith('/project/');

  return (
    <div className="flex h-screen bg-gray-50">
      {/* Sidebar */}
      <div className="w-64 bg-sentry-purple text-white flex flex-col">
        <div className="p-6">
          <h1 className="text-2xl font-bold">SE Copilot</h1>
          <p className="text-sm text-gray-300 mt-1">Sentry Demo Builder</p>
        </div>

        <nav className="flex-1 px-4 space-y-1">
          <NavLink to="/" active={location.pathname === '/'}>
            🏠 Home
          </NavLink>
          <NavLink to="/new" active={location.pathname === '/new'}>
            ➕ New Project
          </NavLink>
          
          {currentProject && (
            <>
              <div className="pt-4 pb-2 text-xs font-semibold text-gray-400 uppercase">
                Current Project
              </div>
              <div className="text-sm text-gray-300 px-3 py-2 bg-white/10 rounded">
                {currentProject.project.name}
              </div>
              <NavLink 
                to={`/project/${currentProject.id}/plan`} 
                active={location.pathname.includes('/plan')}
              >
                📋 Planning
              </NavLink>
              <NavLink 
                to={`/project/${currentProject.id}/generate`} 
                active={location.pathname.includes('/generate')}
                disabled={currentProject.status === 'draft'}
              >
                ⚙️ Generate
              </NavLink>
              <NavLink 
                to={`/project/${currentProject.id}/refine`} 
                active={location.pathname.includes('/refine')}
                disabled={currentProject.status !== 'generated' && currentProject.status !== 'published'}
              >
                🔧 Refine
              </NavLink>
              <NavLink 
                to={`/project/${currentProject.id}/data`} 
                active={location.pathname.includes('/data')}
                disabled={currentProject.status !== 'generated' && currentProject.status !== 'published'}
              >
                🎲 Run Data
              </NavLink>
              <NavLink 
                to={`/project/${currentProject.id}/deploy`} 
                active={location.pathname.includes('/deploy')}
                disabled={currentProject.status !== 'generated' && currentProject.status !== 'published'}
              >
                🖥️ Deploy
              </NavLink>
              <NavLink 
                to={`/project/${currentProject.id}/publish`} 
                active={location.pathname.includes('/publish')}
                disabled={currentProject.status !== 'generated' && currentProject.status !== 'published'}
              >
                🚀 Publish
              </NavLink>
            </>
          )}
        </nav>

        <div className="p-4 border-t border-white/10">
          <NavLink to="/settings" active={location.pathname === '/settings'}>
            ⚙️ Settings
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
    block px-3 py-2 rounded-lg text-sm font-medium transition-colors
    ${active ? 'bg-white/20 text-white' : 'text-gray-300 hover:bg-white/10 hover:text-white'}
    ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}
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
