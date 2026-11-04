import {StrictMode} from 'react';
import type {Root} from 'react-dom/client';
import {createBrowserRouter,RouterProvider} from 'react-router-dom';
import App from './App';
import {UnsavedChangesProvider} from './hooks/useUnsavedChanges';

export function mountErp(root:Root){
 const router=createBrowserRouter([{path:'*',element:<UnsavedChangesProvider><App/></UnsavedChangesProvider>}]);
 root.render(<StrictMode><RouterProvider router={router}/></StrictMode>);
}

import './fagoo-system.css';

import './components/document-layout.css';
