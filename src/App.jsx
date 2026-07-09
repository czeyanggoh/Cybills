import { QueryClientProvider, QueryClient } from '@tanstack/react-query'
import { BrowserRouter as Router, Route, Routes, Navigate } from 'react-router-dom';
import Home from './pages/Home';
import Login from './pages/Login';
import Costs from './pages/Costs';
import ComingSoon from './pages/ComingSoon';

const queryClient = new QueryClient();

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <Router>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/login" element={<Login />} />
          <Route path="/costs" element={<Costs />} />
          <Route path="/sales" element={<ComingSoon />} />
          <Route path="/bank" element={<ComingSoon />} />
          <Route path="/suppliers" element={<ComingSoon />} />
          <Route path="/reports" element={<ComingSoon />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Router>
    </QueryClientProvider>
  )
}

export default App
