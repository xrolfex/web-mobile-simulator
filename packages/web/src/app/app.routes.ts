import { Routes } from '@angular/router';

/** Application route definitions — all feature modules are lazy-loaded. */
export const routes: Routes = [
  {
    path: '',
    loadComponent: () =>
      import('./features/dashboard/dashboard.component').then(
        (m) => m.DashboardComponent,
      ),
  },
  {
    path: 'runtimes',
    loadComponent: () =>
      import('./features/runtimes/runtimes.component').then(
        (m) => m.RuntimesComponent,
      ),
  },
  {
    path: 'session/:id',
    loadComponent: () =>
      import('./features/simulator/simulator-session.component').then(
        (m) => m.SimulatorSessionComponent,
      ),
  },
  {
    path: 'admin',
    loadComponent: () =>
      import('./features/admin/admin.component').then(
        (m) => m.AdminComponent,
      ),
  },
  {
    path: '**',
    redirectTo: '',
  },
];
