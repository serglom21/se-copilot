import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useProjectStore } from '../store/project-store';
import Button from '../components/Button';

export default function HomePage() {
  const { projects, loadProjects, setCurrentProject, deleteProject } = useProjectStore();

  useEffect(() => {
    loadProjects();
  }, []);

  const handleOpenProject = (project: any) => {
    setCurrentProject(project);
  };

  const handleDeleteProject = async (projectId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (confirm('Are you sure you want to delete this project?')) {
      await deleteProject(projectId);
    }
  };

  return (
    <div className="p-8 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Projects</h1>
          <p className="text-gray-600 mt-1">Manage your Sentry demo projects</p>
        </div>
        <Link to="/new">
          <Button size="lg">➕ New Project</Button>
        </Link>
      </div>

      {projects.length === 0 ? (
        <div className="text-center py-16 bg-white rounded-lg border-2 border-dashed border-gray-300">
          <div className="text-6xl mb-4">📂</div>
          <h3 className="text-xl font-semibold text-gray-900 mb-2">No projects yet</h3>
          <p className="text-gray-600 mb-6">Create your first project to get started</p>
          <Link to="/new">
            <Button>Create Project</Button>
          </Link>
        </div>
      ) : (
        <div className="grid gap-4">
          {projects.map(project => (
            <div
              key={project.id}
              className="bg-white rounded-lg border border-gray-200 p-6 hover:shadow-md transition-shadow cursor-pointer"
              onClick={() => handleOpenProject(project)}
            >
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <h3 className="text-xl font-semibold text-gray-900 mb-1">
                    {project.project.name}
                  </h3>
                  <div className="flex items-center gap-4 text-sm text-gray-600 mb-3">
                    <span className="flex items-center gap-1">
                      <span className="font-medium">Vertical:</span> {project.project.vertical}
                    </span>
                    <span className="flex items-center gap-1">
                      <span className="font-medium">Status:</span>
                      <StatusBadge status={project.status} />
                    </span>
                    <span className="flex items-center gap-1">
                      <span className="font-medium">Spans:</span> {project.instrumentation.spans.length}
                    </span>
                  </div>
                  {project.project.notes && (
                    <p className="text-gray-600 text-sm line-clamp-2">{project.project.notes}</p>
                  )}
                </div>
                <div className="flex gap-2">
                  <Link to={`/project/${project.id}/plan`}>
                    <Button size="sm" variant="secondary" onClick={e => e.stopPropagation()}>
                      Open
                    </Button>
                  </Link>
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={e => handleDeleteProject(project.id, e)}
                  >
                    Delete
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    draft: 'bg-gray-100 text-gray-800',
    planning: 'bg-blue-100 text-blue-800',
    locked: 'bg-yellow-100 text-yellow-800',
    generated: 'bg-green-100 text-green-800',
    published: 'bg-purple-100 text-purple-800'
  };

  return (
    <span className={`px-2 py-0.5 rounded text-xs font-medium ${colors[status] || colors.draft}`}>
      {status}
    </span>
  );
}
