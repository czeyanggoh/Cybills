import { QueryClientProvider, QueryClient } from '@tanstack/react-query'
import { BrowserRouter as Router, Route, Routes, Navigate } from 'react-router-dom';
import { AuthProvider } from '@/lib/auth';
import RequireAuth from '@/components/RequireAuth';
import Login from './pages/Login';
import Costs from './pages/Costs';
import CostDetail from './pages/CostDetail';
import ExpenseClaims from './pages/ExpenseClaims';
import Settings from './pages/Settings';
import SupportDesk from './pages/SupportDesk';
import ComingSoon from './pages/ComingSoon';

const queryClient = new QueryClient();

// Wraps the signed-in pages in the auth guard.
function Protected({ children }) {
  return <RequireAuth>{children}</RequireAuth>;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <Router>
          <Routes>
            <Route path="/" element={<Navigate to="/login" replace />} />
            <Route path="/login" element={<Login />} />
            <Route path="/costs" element={<Protected><Costs /></Protected>} />
            <Route path="/costs/:id" element={<Protected><CostDetail /></Protected>} />
            <Route path="/sales" element={<Protected><ComingSoon /></Protected>} />
            <Route path="/bank" element={<Protected><ComingSoon /></Protected>} />
            <Route path="/vault" element={<Protected><ComingSoon /></Protected>} />
            <Route path="/expense-claims" element={<Protected><ExpenseClaims /></Protected>} />
            <Route path="/settings" element={<Protected><Settings /></Protected>} />
            <Route path="/support" element={<Protected><SupportDesk /></Protected>} />
            {/* Feature Requests merged into Support Desk — keep old links working. */}
            <Route path="/features" element={<Navigate to="/support" replace />} />
            <Route path="*" element={<Navigate to="/login" replace />} />
          </Routes>
        </Router>
      </AuthProvider>
    </QueryClientProvider>
  )
}

export default App
