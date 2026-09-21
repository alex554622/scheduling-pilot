export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      app_settings: {
        Row: {
          key: string
          updated_at: string
          value: Json
        }
        Insert: {
          key: string
          updated_at?: string
          value?: Json
        }
        Update: {
          key?: string
          updated_at?: string
          value?: Json
        }
        Relationships: []
      }
      break_reminder_dismissals: {
        Row: {
          company_id: string
          dismissed_at: string
          dismissed_by: string | null
          id: string
          kind: string
          stretch_start: string
          user_id: string
        }
        Insert: {
          company_id: string
          dismissed_at?: string
          dismissed_by?: string | null
          id?: string
          kind: string
          stretch_start: string
          user_id: string
        }
        Update: {
          company_id?: string
          dismissed_at?: string
          dismissed_by?: string | null
          id?: string
          kind?: string
          stretch_start?: string
          user_id?: string
        }
        Relationships: []
      }
      audit_logs: {
        Row: {
          action: string
          actor_id: string | null
          after: Json | null
          before: Json | null
          company_id: string | null
          created_at: string
          entity_id: string | null
          entity_type: string
          id: string
        }
        Insert: {
          action: string
          actor_id?: string | null
          after?: Json | null
          before?: Json | null
          company_id?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type: string
          id?: string
        }
        Update: {
          action?: string
          actor_id?: string | null
          after?: Json | null
          before?: Json | null
          company_id?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string
          id?: string
        }
        Relationships: []
      }
      schedule_templates: {
        Row: {
          company_id: string | null
          created_at: string
          default_work_week_start: number
          description: string
          id: string
          is_editable: boolean
          is_system_template: boolean
          name: string
          owner_id: string | null
          pattern: Json
          pattern_length: number
          schedule_view_type: string
          updated_at: string
        }
        Insert: {
          company_id?: string | null
          created_at?: string
          default_work_week_start?: number
          description?: string
          id?: string
          is_editable?: boolean
          is_system_template?: boolean
          name: string
          owner_id?: string | null
          pattern?: Json
          pattern_length?: number
          schedule_view_type?: string
          updated_at?: string
        }
        Update: {
          company_id?: string | null
          created_at?: string
          default_work_week_start?: number
          description?: string
          id?: string
          is_editable?: boolean
          is_system_template?: boolean
          name?: string
          owner_id?: string | null
          pattern?: Json
          pattern_length?: number
          schedule_view_type?: string
          updated_at?: string
        }
        Relationships: []
      }
      schedule_template_teams: {
        Row: {
          id: string
          name: string
          pattern_offset: number
          shift_end: string
          shift_start: string
          sort_order: number
          template_id: string
        }
        Insert: {
          id?: string
          name: string
          pattern_offset?: number
          shift_end?: string
          shift_start?: string
          sort_order?: number
          template_id: string
        }
        Update: {
          id?: string
          name?: string
          pattern_offset?: number
          shift_end?: string
          shift_start?: string
          sort_order?: number
          template_id?: string
        }
        Relationships: []
      }
      kiosk_devices: {
        Row: {
          company_id: string
          created_at: string
          created_by: string | null
          failed_attempts: number
          id: string
          label: string
          last_used_at: string | null
          locked_until: string | null
          revoked_at: string | null
          token: string
        }
        Insert: {
          company_id: string
          created_at?: string
          created_by?: string | null
          failed_attempts?: number
          id?: string
          label?: string
          last_used_at?: string | null
          locked_until?: string | null
          revoked_at?: string | null
          token: string
        }
        Update: {
          company_id?: string
          created_at?: string
          created_by?: string | null
          failed_attempts?: number
          id?: string
          label?: string
          last_used_at?: string | null
          locked_until?: string | null
          revoked_at?: string | null
          token?: string
        }
        Relationships: []
      }
      employee_clock_codes: {
        Row: {
          code: string
          company_id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          code: string
          company_id: string
          updated_at?: string
          user_id: string
        }
        Update: {
          code?: string
          company_id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      companies: {
        Row: {
          billing_mode: string
          created_at: string
          data_retention_months: number | null
          geofence_radius_m: number
          id: string
          join_code: string | null
          latitude: number | null
          longitude: number | null
          name: string
          plan: string
          settings: Json
          status: string
          timezone: string
        }
        Insert: {
          billing_mode?: string
          created_at?: string
          data_retention_months?: number | null
          geofence_radius_m?: number
          id?: string
          join_code?: string | null
          latitude?: number | null
          longitude?: number | null
          name: string
          plan?: string
          settings?: Json
          status?: string
          timezone?: string
        }
        Update: {
          billing_mode?: string
          created_at?: string
          data_retention_months?: number | null
          geofence_radius_m?: number
          id?: string
          join_code?: string | null
          latitude?: number | null
          longitude?: number | null
          name?: string
          plan?: string
          settings?: Json
          status?: string
          timezone?: string
        }
        Relationships: []
      }
      company_subscriptions: {
        Row: {
          cancel_at_period_end: boolean
          company_id: string
          created_at: string
          current_period_end: string | null
          current_period_start: string | null
          external_customer_id: string | null
          external_subscription_id: string | null
          id: string
          plan_id: string | null
          seats_limit: number | null
          status: string
          updated_at: string
        }
        Insert: {
          cancel_at_period_end?: boolean
          company_id: string
          created_at?: string
          current_period_end?: string | null
          current_period_start?: string | null
          external_customer_id?: string | null
          external_subscription_id?: string | null
          id?: string
          plan_id?: string | null
          seats_limit?: number | null
          status?: string
          updated_at?: string
        }
        Update: {
          cancel_at_period_end?: boolean
          company_id?: string
          created_at?: string
          current_period_end?: string | null
          current_period_start?: string | null
          external_customer_id?: string | null
          external_subscription_id?: string | null
          id?: string
          plan_id?: string | null
          seats_limit?: number | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "company_subscriptions_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: true
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "company_subscriptions_plan_id_fkey"
            columns: ["plan_id"]
            isOneToOne: false
            referencedRelation: "pricing_plans"
            referencedColumns: ["id"]
          },
        ]
      }
      departments: {
        Row: {
          company_id: string
          created_at: string
          description: string | null
          id: string
          name: string
        }
        Insert: {
          company_id: string
          created_at?: string
          description?: string | null
          id?: string
          name: string
        }
        Update: {
          company_id?: string
          created_at?: string
          description?: string | null
          id?: string
          name?: string
        }
        Relationships: [
          {
            foreignKeyName: "departments_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      employee_availability: {
        Row: {
          company_id: string
          created_at: string
          effective_from: string | null
          effective_to: string | null
          employee_id: string
          end_time: string
          id: string
          is_available: boolean
          note: string | null
          start_time: string
          weekday: number
        }
        Insert: {
          company_id: string
          created_at?: string
          effective_from?: string | null
          effective_to?: string | null
          employee_id: string
          end_time: string
          id?: string
          is_available?: boolean
          note?: string | null
          start_time: string
          weekday: number
        }
        Update: {
          company_id?: string
          created_at?: string
          effective_from?: string | null
          effective_to?: string | null
          employee_id?: string
          end_time?: string
          id?: string
          is_available?: boolean
          note?: string | null
          start_time?: string
          weekday?: number
        }
        Relationships: [
          {
            foreignKeyName: "employee_availability_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      employee_positions: {
        Row: {
          company_id: string
          created_at: string
          employee_id: string
          id: string
          is_primary: boolean
          position_id: string
        }
        Insert: {
          company_id: string
          created_at?: string
          employee_id: string
          id?: string
          is_primary?: boolean
          position_id: string
        }
        Update: {
          company_id?: string
          created_at?: string
          employee_id?: string
          id?: string
          is_primary?: boolean
          position_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "employee_positions_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employee_positions_position_id_fkey"
            columns: ["position_id"]
            isOneToOne: false
            referencedRelation: "positions"
            referencedColumns: ["id"]
          },
        ]
      }
      employment_separations: {
        Row: {
          company_id: string
          id: string
          note: string | null
          prior_department_id: string | null
          prior_employee_code: string | null
          prior_full_name: string
          prior_max_weekly_hours: number | null
          prior_position: string | null
          prior_position_id: string | null
          prior_roles: Database["public"]["Enums"]["app_role"][]
          reason: Database["public"]["Enums"]["separation_reason"]
          rehired_at: string | null
          rehired_by: string | null
          separated_at: string
          separated_by: string | null
          user_id: string
        }
        Insert: {
          company_id: string
          id?: string
          note?: string | null
          prior_department_id?: string | null
          prior_employee_code?: string | null
          prior_full_name?: string
          prior_max_weekly_hours?: number | null
          prior_position?: string | null
          prior_position_id?: string | null
          prior_roles?: Database["public"]["Enums"]["app_role"][]
          reason: Database["public"]["Enums"]["separation_reason"]
          rehired_at?: string | null
          rehired_by?: string | null
          separated_at?: string
          separated_by?: string | null
          user_id: string
        }
        Update: {
          company_id?: string
          id?: string
          note?: string | null
          prior_department_id?: string | null
          prior_employee_code?: string | null
          prior_full_name?: string
          prior_max_weekly_hours?: number | null
          prior_position?: string | null
          prior_position_id?: string | null
          prior_roles?: Database["public"]["Enums"]["app_role"][]
          reason?: Database["public"]["Enums"]["separation_reason"]
          rehired_at?: string | null
          rehired_by?: string | null
          separated_at?: string
          separated_by?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "employment_separations_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      invitations: {
        Row: {
          accepted_at: string | null
          accepted_by: string | null
          company_id: string
          created_at: string
          email: string
          expires_at: string
          id: string
          invited_by: string
          role: Database["public"]["Enums"]["app_role"]
          status: string
          token: string
        }
        Insert: {
          accepted_at?: string | null
          accepted_by?: string | null
          company_id: string
          created_at?: string
          email: string
          expires_at?: string
          id?: string
          invited_by: string
          role: Database["public"]["Enums"]["app_role"]
          status?: string
          token?: string
        }
        Update: {
          accepted_at?: string | null
          accepted_by?: string | null
          company_id?: string
          created_at?: string
          email?: string
          expires_at?: string
          id?: string
          invited_by?: string
          role?: Database["public"]["Enums"]["app_role"]
          status?: string
          token?: string
        }
        Relationships: []
      }
      locations: {
        Row: {
          address: string | null
          company_id: string
          created_at: string
          geofence_radius_m: number
          id: string
          latitude: number | null
          longitude: number | null
          name: string
        }
        Insert: {
          address?: string | null
          company_id: string
          created_at?: string
          geofence_radius_m?: number
          id?: string
          latitude?: number | null
          longitude?: number | null
          name: string
        }
        Update: {
          address?: string | null
          company_id?: string
          created_at?: string
          geofence_radius_m?: number
          id?: string
          latitude?: number | null
          longitude?: number | null
          name?: string
        }
        Relationships: [
          {
            foreignKeyName: "locations_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      notifications: {
        Row: {
          body: string | null
          created_at: string
          id: string
          link: string | null
          read_at: string | null
          title: string
          type: string
          user_id: string
        }
        Insert: {
          body?: string | null
          created_at?: string
          id?: string
          link?: string | null
          read_at?: string | null
          title: string
          type: string
          user_id: string
        }
        Update: {
          body?: string | null
          created_at?: string
          id?: string
          link?: string | null
          read_at?: string | null
          title?: string
          type?: string
          user_id?: string
        }
        Relationships: []
      }
      positions: {
        Row: {
          color: string
          company_id: string
          created_at: string
          description: string | null
          id: string
          name: string
        }
        Insert: {
          color?: string
          company_id: string
          created_at?: string
          description?: string | null
          id?: string
          name: string
        }
        Update: {
          color?: string
          company_id?: string
          created_at?: string
          description?: string | null
          id?: string
          name?: string
        }
        Relationships: [
          {
            foreignKeyName: "positions_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      pricing_plans: {
        Row: {
          active: boolean
          capabilities: Json
          capacity: string
          created_at: string
          featured: boolean
          features: Json
          id: string
          max_employees: number | null
          name: string
          price_cents: number
          sort_order: number
          updated_at: string
        }
        Insert: {
          active?: boolean
          capabilities?: Json
          capacity?: string
          created_at?: string
          featured?: boolean
          features?: Json
          id?: string
          max_employees?: number | null
          name: string
          price_cents?: number
          sort_order?: number
          updated_at?: string
        }
        Update: {
          active?: boolean
          capabilities?: Json
          capacity?: string
          created_at?: string
          featured?: boolean
          features?: Json
          id?: string
          max_employees?: number | null
          name?: string
          price_cents?: number
          sort_order?: number
          updated_at?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          company_id: string | null
          created_at: string
          department_id: string | null
          employee_code: string | null
          full_name: string
          id: string
          is_active: boolean
          max_weekly_hours: number
          notification_prefs: Json
          pending_company_id: string | null
          phone: string | null
          position: string | null
          position_id: string | null
        }
        Insert: {
          company_id?: string | null
          created_at?: string
          department_id?: string | null
          employee_code?: string | null
          full_name?: string
          id: string
          is_active?: boolean
          max_weekly_hours?: number
          notification_prefs?: Json
          pending_company_id?: string | null
          phone?: string | null
          position?: string | null
          position_id?: string | null
        }
        Update: {
          company_id?: string | null
          created_at?: string
          department_id?: string | null
          employee_code?: string | null
          full_name?: string
          id?: string
          is_active?: boolean
          max_weekly_hours?: number
          notification_prefs?: Json
          pending_company_id?: string | null
          phone?: string | null
          position?: string | null
          position_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "profiles_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "profiles_department_id_fkey"
            columns: ["department_id"]
            isOneToOne: false
            referencedRelation: "departments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "profiles_pending_company_id_fkey"
            columns: ["pending_company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "profiles_position_id_fkey"
            columns: ["position_id"]
            isOneToOne: false
            referencedRelation: "positions"
            referencedColumns: ["id"]
          },
        ]
      }
      schedules: {
        Row: {
          company_id: string
          created_at: string
          created_by: string | null
          department_id: string | null
          ends_on: string
          id: string
          location_id: string | null
          name: string
          published_at: string | null
          published_by: string | null
          starts_on: string
          status: string
          source_template_id: string | null
          pattern_snapshot: Json | null
          teams_snapshot: Json | null
          work_week_start: number | null
          anchor_date: string | null
          schedule_year: number | null
        }
        Insert: {
          company_id: string
          created_at?: string
          created_by?: string | null
          department_id?: string | null
          ends_on: string
          id?: string
          location_id?: string | null
          name: string
          published_at?: string | null
          published_by?: string | null
          starts_on: string
          status?: string
          source_template_id?: string | null
          pattern_snapshot?: Json | null
          teams_snapshot?: Json | null
          work_week_start?: number | null
          anchor_date?: string | null
          schedule_year?: number | null
        }
        Update: {
          company_id?: string
          created_at?: string
          created_by?: string | null
          department_id?: string | null
          ends_on?: string
          id?: string
          location_id?: string | null
          name?: string
          published_at?: string | null
          published_by?: string | null
          starts_on?: string
          status?: string
          source_template_id?: string | null
          pattern_snapshot?: Json | null
          teams_snapshot?: Json | null
          work_week_start?: number | null
          anchor_date?: string | null
          schedule_year?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "schedules_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "schedules_department_id_fkey"
            columns: ["department_id"]
            isOneToOne: false
            referencedRelation: "departments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "schedules_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "locations"
            referencedColumns: ["id"]
          },
        ]
      }
      shift_templates: {
        Row: {
          break_minutes: number
          color: string
          company_id: string
          created_at: string
          department_id: string | null
          end_time: string
          id: string
          location_id: string | null
          name: string
          position_id: string | null
          required_headcount: number
          start_time: string
        }
        Insert: {
          break_minutes?: number
          color?: string
          company_id: string
          created_at?: string
          department_id?: string | null
          end_time: string
          id?: string
          location_id?: string | null
          name: string
          position_id?: string | null
          required_headcount?: number
          start_time: string
        }
        Update: {
          break_minutes?: number
          color?: string
          company_id?: string
          created_at?: string
          department_id?: string | null
          end_time?: string
          id?: string
          location_id?: string | null
          name?: string
          position_id?: string | null
          required_headcount?: number
          start_time?: string
        }
        Relationships: [
          {
            foreignKeyName: "shift_templates_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shift_templates_department_id_fkey"
            columns: ["department_id"]
            isOneToOne: false
            referencedRelation: "departments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shift_templates_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "locations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shift_templates_position_id_fkey"
            columns: ["position_id"]
            isOneToOne: false
            referencedRelation: "positions"
            referencedColumns: ["id"]
          },
        ]
      }
      shift_trades: {
        Row: {
          company_id: string
          created_at: string
          from_employee_id: string
          id: string
          shift_id: string
          status: string
          to_employee_id: string
          to_shift_id: string | null
        }
        Insert: {
          company_id: string
          created_at?: string
          from_employee_id: string
          id?: string
          shift_id: string
          status?: string
          to_employee_id: string
          to_shift_id?: string | null
        }
        Update: {
          company_id?: string
          created_at?: string
          from_employee_id?: string
          id?: string
          shift_id?: string
          status?: string
          to_employee_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "shift_trades_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shift_trades_shift_id_fkey"
            columns: ["shift_id"]
            isOneToOne: false
            referencedRelation: "shifts"
            referencedColumns: ["id"]
          },
        ]
      }
      shifts: {
        Row: {
          break_minutes: number
          color: string
          company_id: string
          created_at: string
          department_id: string | null
          employee_id: string | null
          ends_at: string
          id: string
          location_id: string | null
          notes: string | null
          position: string
          position_id: string | null
          published: boolean
          schedule_id: string | null
          starts_at: string
          template_id: string | null
        }
        Insert: {
          break_minutes?: number
          color?: string
          company_id: string
          created_at?: string
          department_id?: string | null
          employee_id?: string | null
          ends_at: string
          id?: string
          location_id?: string | null
          notes?: string | null
          position?: string
          position_id?: string | null
          published?: boolean
          schedule_id?: string | null
          starts_at: string
          template_id?: string | null
        }
        Update: {
          break_minutes?: number
          color?: string
          company_id?: string
          created_at?: string
          department_id?: string | null
          employee_id?: string | null
          ends_at?: string
          id?: string
          location_id?: string | null
          notes?: string | null
          position?: string
          position_id?: string | null
          published?: boolean
          schedule_id?: string | null
          starts_at?: string
          template_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "shifts_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shifts_department_id_fkey"
            columns: ["department_id"]
            isOneToOne: false
            referencedRelation: "departments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shifts_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "locations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shifts_position_id_fkey"
            columns: ["position_id"]
            isOneToOne: false
            referencedRelation: "positions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shifts_schedule_id_fkey"
            columns: ["schedule_id"]
            isOneToOne: false
            referencedRelation: "schedules"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shifts_template_id_fkey"
            columns: ["template_id"]
            isOneToOne: false
            referencedRelation: "shift_templates"
            referencedColumns: ["id"]
          },
        ]
      }
      time_off_requests: {
        Row: {
          company_id: string
          created_at: string
          employee_id: string
          end_date: string
          id: string
          kind: string
          note: string | null
          start_date: string
          status: string
        }
        Insert: {
          company_id: string
          created_at?: string
          employee_id: string
          end_date: string
          id?: string
          kind?: string
          note?: string | null
          start_date: string
          status?: string
        }
        Update: {
          company_id?: string
          created_at?: string
          employee_id?: string
          end_date?: string
          id?: string
          kind?: string
          note?: string | null
          start_date?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "time_off_requests_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      time_punch_audit: {
        Row: {
          action: string
          actor_id: string
          after: Json | null
          before: Json | null
          company_id: string
          created_at: string
          id: string
          punch_id: string | null
          reason: string
          user_id: string
        }
        Insert: {
          action: string
          actor_id: string
          after?: Json | null
          before?: Json | null
          company_id: string
          created_at?: string
          id?: string
          punch_id?: string | null
          reason: string
          user_id: string
        }
        Update: {
          action?: string
          actor_id?: string
          after?: Json | null
          before?: Json | null
          company_id?: string
          created_at?: string
          id?: string
          punch_id?: string | null
          reason?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "time_punch_audit_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      time_punches: {
        Row: {
          accuracy_m: number | null
          at: string
          break_minutes: number | null
          company_id: string
          created_at: string
          distance_m: number | null
          id: string
          kind: string
          latitude: number | null
          longitude: number | null
          note: string | null
          user_id: string
          within_geofence: boolean
        }
        Insert: {
          accuracy_m?: number | null
          at?: string
          break_minutes?: number | null
          company_id: string
          created_at?: string
          distance_m?: number | null
          id?: string
          kind: string
          latitude?: number | null
          longitude?: number | null
          note?: string | null
          user_id: string
          within_geofence?: boolean
        }
        Update: {
          accuracy_m?: number | null
          at?: string
          break_minutes?: number | null
          company_id?: string
          created_at?: string
          distance_m?: number | null
          id?: string
          kind?: string
          latitude?: number | null
          longitude?: number | null
          note?: string | null
          user_id?: string
          within_geofence?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "time_punches_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      user_roles: {
        Row: {
          company_id: string | null
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          company_id?: string | null
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          company_id?: string | null
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_roles_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      accept_invitation: { Args: { _token: string }; Returns: string }
      is_platform_admin: { Args: never; Returns: boolean }
      manager_delete_punch_range: {
        Args: {
          _company: string
          _user: string | null
          _from: string
          _to: string
          _reason: string
        }
        Returns: number
      }
      company_history_stats: { Args: { _company: string }; Returns: Json }
      purge_company_history: { Args: { _company: string }; Returns: Json }
      create_kiosk_device: {
        Args: { _label?: string }
        Returns: Database["public"]["Tables"]["kiosk_devices"]["Row"]
      }
      revoke_kiosk_device: { Args: { _id: string }; Returns: undefined }
      set_employee_clock_code: { Args: { _user: string }; Returns: string }
      clear_employee_clock_code: { Args: { _user: string }; Returns: undefined }
      kiosk_device_info: { Args: { _token: string }; Returns: Json }
      kiosk_state: { Args: { _token: string; _code: string }; Returns: Json }
      kiosk_punch: {
        Args: { _token: string; _code: string; _action: string; _minutes?: number | null }
        Returns: Json
      }
      approve_membership: { Args: { _user: string }; Returns: undefined }
      bootstrap_company: { Args: { _name: string }; Returns: string }
      remove_company_member: {
        Args: {
          _user: string
          _reason?: Database["public"]["Enums"]["separation_reason"]
          _note?: string
        }
        Returns: undefined
      }
      rehire_company_member: { Args: { _user: string }; Returns: undefined }
      forget_former_member: { Args: { _user: string }; Returns: undefined }
      break_punch: {
        Args: {
          _accuracy?: number
          _lat: number
          _lng: number
          _minutes?: number
        }
        Returns: {
          accuracy_m: number | null
          at: string
          break_minutes: number | null
          company_id: string
          created_at: string
          distance_m: number | null
          id: string
          kind: string
          latitude: number | null
          longitude: number | null
          note: string | null
          user_id: string
          within_geofence: boolean
        }
        SetofOptions: {
          from: "*"
          to: "time_punches"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      check_shift_conflicts: {
        Args: {
          _employee_id: string
          _ends_at: string
          _position_id?: string
          _shift_id?: string
          _starts_at: string
        }
        Returns: {
          code: string
          message: string
          severity: string
        }[]
      }
      check_trade_conflicts: {
        Args: { _shift_id: string; _to_employee_id: string }
        Returns: {
          code: string
          message: string
          severity: string
        }[]
      }
      approve_trade: { Args: { _trade: string; _approve: boolean }; Returns: Json }
      respond_to_trade: { Args: { _trade: string; _accept: boolean }; Returns: Json }
      claim_super_admin: { Args: never; Returns: boolean }
      dismiss_break_reminder: { Args: { _user: string; _kind: string; _stretch_start: string }; Returns: undefined }
      company_presence: {
        Args: never
        Returns: {
          full_name: string
          job_title: string | null
          status: string
          user_id: string
        }[]
      }
      admin_accounts: {
        Args: never
        Returns: {
          user_id: string
          email: string | null
          email_confirmed: boolean
          created_at: string
          last_sign_in_at: string | null
          full_name: string
          company_id: string | null
          company_name: string | null
          pending_company_id: string | null
          pending_company_name: string | null
          is_active: boolean
          has_profile: boolean
          roles: string[]
        }[]
      }
      admin_set_user_company: { Args: { _user: string; _company: string | null }; Returns: undefined }
      admin_set_user_role: {
        Args: { _user: string; _company: string | null; _role: string | null }
        Returns: undefined
      }
      admin_delete_user: { Args: { _user: string }; Returns: undefined }
      billing_overview: {
        Args: never
        Returns: {
          admin_email: string | null
          amount_cents: number
          company_id: string
          company_name: string
          company_status: string
          days_until: number | null
          overdue: boolean
          period_end: string | null
          plan_name: string
          sub_status: string
        }[]
      }
      extend_subscription: { Args: { _company: string; _days: number; _reason?: string }; Returns: string }
      mark_invoice_sent: { Args: { _invoice: string; _to: string }; Returns: Json }
      mark_subscription_paid: { Args: { _company: string; _months?: number; _note?: string }; Returns: Json }
      next_invoice_number: { Args: never; Returns: string }
      set_billing_date: { Args: { _company: string; _date: string; _reason?: string }; Returns: string }
      suspend_company_for_nonpayment: { Args: { _company: string; _reason?: string }; Returns: undefined }
      company_capabilities: { Args: { _company: string }; Returns: Json }
      company_has_capability: { Args: { _company: string; _key: string }; Returns: boolean }
      company_plan_id: { Args: { _company: string }; Returns: string }
      company_seat_limit: { Args: { _company: string }; Returns: number }
      company_trial_status: { Args: { _company: string }; Returns: Json }
      trial_days: { Args: never; Returns: number }
      trial_plan_id: { Args: never; Returns: string }
      default_plan_capabilities: { Args: never; Returns: Json }
      clock_punch: {
        Args: { _accuracy?: number; _lat: number; _lng: number }
        Returns: {
          accuracy_m: number | null
          at: string
          break_minutes: number | null
          company_id: string
          created_at: string
          distance_m: number | null
          id: string
          kind: string
          latitude: number | null
          longitude: number | null
          note: string | null
          user_id: string
          within_geofence: boolean
        }
        SetofOptions: {
          from: "*"
          to: "time_punches"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      company_can_schedule: { Args: { _company: string }; Returns: boolean }
      current_company_id: { Args: never; Returns: string }
      discard_schedule: { Args: { _schedule_id: string }; Returns: number }
      generate_company_join_code: { Args: never; Returns: string }
      generate_schedule: {
        Args: {
          _allow_overtime?: boolean
          _employee_ids?: string[]
          _ends_on: string
          _name: string
          _respect_availability?: boolean
          _rules: Json
          _starts_on: string
        }
        Returns: Json
      }
      get_invitation_by_token: {
        Args: { _token: string }
        Returns: {
          company_id: string
          company_name: string
          email: string
          expires_at: string
          id: string
          role: Database["public"]["Enums"]["app_role"]
          status: string
        }[]
      }
      has_role: {
        Args: {
          _company?: string
          _role: Database["public"]["Enums"]["app_role"]
          _user: string
        }
        Returns: boolean
      }
      haversine_m: {
        Args: { lat1: number; lat2: number; lon1: number; lon2: number }
        Returns: number
      }
      is_company_manager: {
        Args: { _company: string; _user: string }
        Returns: boolean
      }
      join_company: { Args: { _company: string }; Returns: undefined }
      join_company_by_code: { Args: { _code: string }; Returns: string }
      manager_delete_punch: {
        Args: { _id: string; _reason: string }
        Returns: undefined
      }
      manager_insert_punch: {
        Args: { _at: string; _kind: string; _minutes?: number | null; _reason: string; _user_id: string }
        Returns: {
          accuracy_m: number | null
          at: string
          break_minutes: number | null
          company_id: string
          created_at: string
          distance_m: number | null
          id: string
          kind: string
          latitude: number | null
          longitude: number | null
          note: string | null
          user_id: string
          within_geofence: boolean
        }
        SetofOptions: {
          from: "*"
          to: "time_punches"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      manager_update_punch: {
        Args: { _at: string; _id: string; _kind: string; _minutes?: number | null; _reason: string }
        Returns: {
          accuracy_m: number | null
          at: string
          break_minutes: number | null
          company_id: string
          created_at: string
          distance_m: number | null
          id: string
          kind: string
          latitude: number | null
          longitude: number | null
          note: string | null
          user_id: string
          within_geofence: boolean
        }
        SetofOptions: {
          from: "*"
          to: "time_punches"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      reject_membership: { Args: { _user: string }; Returns: undefined }
      set_company_location: {
        Args: { _lat: number; _lng: number; _radius: number }
        Returns: undefined
      }
    }
    Enums: {
      app_role: "super_admin" | "company_admin" | "supervisor" | "employee"
      separation_reason: "rehire" | "laid_off" | "other"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      app_role: ["super_admin", "company_admin", "supervisor", "employee"],
      separation_reason: ["rehire", "laid_off", "other"],
    },
  },
} as const
